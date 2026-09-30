import axios from 'axios';
import { extractStream, ExtractorConfig, detectExtractor } from '../extractors';
import { makeDnsSafeAgent } from '../dns-resolve';
import { cached } from '../cache';
import { titlesMatch, expandTitles } from '../matching';
import { probeMaster, resLabel, probeTarget } from '../multiaudio';
import { makeEndpointConfig } from '../endpoint-config';

// Cinepulse (cinepulse.live) — FILMS FR uniquement, VF (TRUEFRENCH) + VOSTFR. App
// Laravel **Livewire**. Pas de section séries exploitable.
//
// Protocole (reversé le 2026-09-30) :
//   Recherche : composant Livewire « search-component ». On lit sur l'accueil le
//   `csrf-token` + le `wire:snapshot` du composant, puis POST /livewire/update
//   { _token, components:[{ snapshot, updates:{q:<titre>}, calls:[] }] } -> la réponse
//   porte les résultats dans components[0].effects.html (<a href="/movie/<slug>">, alt,
//   poster TMDB).
//   Fiche : GET /movie/<slug> -> les serveurs sont DANS la page (wire:snapshot échappé) :
//   { server_name, label, version(TRUEFRENCH|VOSTFR|MULTI), embed_type, link }.
//   Hôtes : surtout **vidzy** (.cc/.live, extractible) ; Byse/kakaflix ignorés.
//   Matching : titre + POSTER TMDB (la fiche n'a pas d'id TMDB). Langue = `version`.

const siteEndpoints = makeEndpointConfig('cinepulse-endpoints.json', 'CINEPULSE_ENDPOINTS_CONFIG', {
  base: 'https://cinepulse.live',
});
export const reloadCinepulseEndpoints = siteEndpoints.reload;
export const getCinepulseEndpoints = siteEndpoints.get;

const BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const CTX_TTL_MS = 10 * 60 * 1000;   // csrf + snapshot du composant de recherche
const REQ_TIMEOUT_MS = 15000;
const MAX_SERVERS = 6;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' };

const agent = makeDnsSafeAgent();

export interface CinepulseStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR | MULTI
  server: string;
  headers?: Record<string, string>;
}

async function fetchText(url: string, referer?: string): Promise<string | null> {
  try {
    const { data, status } = await axios.get<string>(url, {
      headers: { ...HEADERS, ...(referer ? { Referer: referer } : {}) },
      timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
      validateStatus: () => true, maxRedirects: 5, httpsAgent: agent,
    });
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\\\//g, '/');

// --- Contexte de recherche (csrf + snapshot du composant), mis en cache ----------

let ctxCache: { csrf: string; snapshot: string; at: number } | null = null;

async function searchContext(): Promise<{ csrf: string; snapshot: string } | null> {
  if (ctxCache && Date.now() - ctxCache.at < CTX_TTL_MS) return ctxCache;
  const html = await fetchText(`${BASE()}/`, `${BASE()}/`);
  if (!html) return null;
  const csrf = html.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
  let snapshot = '';
  for (const m of html.matchAll(/wire:snapshot="([^"]+)"/g)) {
    const s = unescapeHtml(m[1]);
    if (s.includes('search-component')) { snapshot = s; break; }
  }
  if (!csrf || !snapshot) return null;
  ctxCache = { csrf, snapshot, at: Date.now() };
  return ctxCache;
}

// --- Recherche (Livewire) --------------------------------------------------------

interface SearchItem { slug: string; title: string; poster: string; }

async function search(query: string): Promise<SearchItem[]> {
  const ctx = await searchContext();
  if (!ctx) return [];
  try {
    const { data, status } = await axios.post(
      `${BASE()}/livewire/update`,
      { _token: ctx.csrf, components: [{ snapshot: ctx.snapshot, updates: { q: query }, calls: [] }] },
      {
        headers: { ...HEADERS, Referer: `${BASE()}/`, 'Content-Type': 'application/json', 'X-Livewire': '1', 'X-CSRF-TOKEN': ctx.csrf },
        timeout: REQ_TIMEOUT_MS, validateStatus: () => true, httpsAgent: agent,
      },
    );
    if (status < 200 || status >= 300) { ctxCache = null; return []; } // csrf/snapshot périmé -> on invalide
    const html = unescapeHtml(String(data?.components?.[0]?.effects?.html || ''));
    const out: SearchItem[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(/<a[^>]+href="[^"]*\/movie\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const slug = m[1], body = m[2];
      if (seen.has(slug)) continue;
      const title = body.match(/alt="([^"]+)"/)?.[1] || '';
      const poster = body.match(/image\.tmdb\.org\/[^"' ]*\/([a-zA-Z0-9]+\.[a-z]+)/)?.[1] || '';
      if (!title) continue;
      seen.add(slug);
      out.push({ slug, title, poster });
    }
    return out;
  } catch { return []; }
}

// --- Fiche -> serveurs (version + lien) ------------------------------------------

interface Server { version: string; link: string; }

function parseServers(ficheHtml: string): Server[] {
  const dh = unescapeHtml(ficheHtml);
  const out: Server[] = [];
  const seen = new Set<string>();
  // Chaque serveur : {…"version":"X"…"link":"<url>"…}. On prend la version la plus
  // proche EN AMONT de chaque lien embed.
  for (const m of dh.matchAll(/"link":"(https?:\/\/[^"]+)"/g)) {
    const link = m[1];
    if (seen.has(link) || !/^https?:\/\//.test(link)) continue;
    seen.add(link);
    const before = dh.slice(Math.max(0, m.index! - 200), m.index!);
    const version = [...before.matchAll(/"version":"([^"]+)"/g)].pop()?.[1] || '';
    out.push({ version, link });
  }
  return out;
}

function languageOf(version: string): string {
  const v = version.toLowerCase();
  if (/vostfr|vost/.test(v)) return 'VOSTFR';
  if (/multi/.test(v)) return 'MULTI';
  return 'VF'; // TRUEFRENCH / VFF / VF / FRENCH -> doublage
}

function serverName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return 'cinepulse'; }
}

// --- Point d'entrée --------------------------------------------------------------

export async function getCinepulseStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle?: string,
  posters?: string[],
): Promise<CinepulseStream[]> {
  if (mediaType !== 'movie' || !title) return []; // catalogue FILMS uniquement
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  return cached(
    `cinepulse:${mode}:${title.toLowerCase()}`, STREAMS_TTL_MS,
    () => fetchCinepulseStreams(extractorConfig, title, originalTitle, posters),
    { scope: 'cinepulse', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchCinepulseStreams(
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle: string | undefined,
  posters: string[] | undefined,
): Promise<CinepulseStream[]> {
  const wanted = expandTitles([title, originalTitle].filter(Boolean) as string[]);
  const posterSet = new Set((posters || []).filter(Boolean));

  // 1. Recherche + matching titre / POSTER TMDB (désambiguïsation exacte).
  let items: SearchItem[] = [];
  for (const t of [title, originalTitle].filter(Boolean) as string[]) {
    items = await search(t);
    if (items.length) break;
  }
  const candidates = items.filter(it => titlesMatch(wanted, it.title));
  if (!candidates.length) { console.log(`[Cinepulse] pas de correspondance pour "${title}"`); return []; }
  const hit = (posterSet.size ? candidates.find(c => posterSet.has(c.poster)) : candidates[0]);
  if (!hit) { console.log(`[Cinepulse] "${title}" : aucun poster ne correspond`); return []; }

  // 2. Fiche -> serveurs (version + lien).
  const ficheHtml = await fetchText(`${BASE()}/movie/${hit.slug}`, `${BASE()}/`);
  if (!ficheHtml) return [];
  const servers = parseServers(ficheHtml).filter(s => detectExtractor(s.link)).slice(0, MAX_SERVERS);
  if (!servers.length) return [];

  // 3. Extraction en parallèle. Les hôtes servent des MASTERS HLS -> on sonde
  // probeMaster (RESOLUTION réelle, remplace le « HD » générique, + relabel MULTI si
  // ≥2 pistes audio). On sonde le CDN BRUT (probeTarget). ⚠️ On NE jette PAS sur 403 :
  // tnmr (livavid) refuse les IP serveur mais on le sert via le proxy LOCAL (bonne IP),
  // et vidzy renvoie un 403-throttle transitoire. On n'écarte que le lien MORT (404/410).
  const DEAD = -404;
  const streams = (await Promise.all(servers.map(async (s): Promise<CinepulseStream[]> => {
    const id = detectExtractor(s.link) || undefined;
    const r = await extractStream(s.link, extractorConfig, id);
    if (!r?.url) return [];
    let language = languageOf(s.version);
    let quality = r.quality || 'HD';
    if (r.format === 'hls' || /\.m3u8/i.test(r.url)) {
      const t = probeTarget(r.url, r.headers || {});
      const { langs, height, width } = await probeMaster(t.url, t.headers);
      if (langs === DEAD) return []; // lien mort côté CDN
      if (height) { const lbl = resLabel(height, width); if (lbl) quality = lbl; }
      if (langs >= 2 && !/multi/i.test(language)) language = 'MULTI';
    }
    return [{ url: r.url, quality, language, server: serverName(s.link), headers: r.headers }];
  }))).flat();

  console.log(`[Cinepulse] ${streams.length} flux pour "${title}"`);
  return streams;
}

/** Sonde de santé : la recherche Livewire répond-elle avec des films ? */
export async function cinepulseProbe(): Promise<boolean> {
  return (await search('spider')).length > 0;
}

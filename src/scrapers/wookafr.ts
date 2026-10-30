import axios from 'axios';
import { extractStream, ExtractorConfig, detectExtractor } from '../extractors';
import { makeDnsSafeAgent } from '../dns-resolve';
import { cached } from '../cache';
import { titlesMatch, expandTitles } from '../matching';
import { probeHlsResolution } from '../hls-resolution';
import { makeEndpointConfig } from '../endpoint-config';

// WookaFR (annuaire « wow-films », #1) — FILMS + SÉRIES FR, VF + VOSTFR. WordPress
// DooPlay (thème « somosmovies ») sur domaine rotatif (wookafr.center -> .boston/.tel…).
//
// Protocole (reversé le 2026-09-29) :
//   Recherche DooPlay : GET /?s=<titre> -> items { alt (titre), poster TMDB, href fiche }.
//   Fiche film   : /streaming/<genre>/<slug>/         -> <iframe src="lecteurvideo.com/embed.php?id=…">
//   Fiche série  : /streaming/series/<slug>/          -> liens /streaming/episodes/<slug>-saison-<S>-episode-<E>/
//                  -> la page épisode porte l'embed lecteurvideo.
//   L'embed lecteurvideo (lecteur central PARTAGÉ : megakino/pelisprincesas aussi) liste
//   TOUS les hôtes en clair, encodés en BASE64 (pas de chiffrement, malgré le nom
//   « encryptedDatanew ») : `showVideo('<base64(url)>', '<sand>')`. atob -> URL de l'hôte.
//   Hôtes vus : uqload, voe, vidmoly, lulustream (extraits) ; emmmmbed/waaw/veev/dsvplay/
//   morencius/coflix.upn (inconnus/WebView) -> ignorés.
//   Matching : titre FR + POSTER TMDB (image.tmdb.org/.../<poster>) = rapprochement exact
//   par tmdbId (la fiche n'expose pas d'id TMDB). Langue déduite de la fiche.

const siteEndpoints = makeEndpointConfig('wookafr-endpoints.json', 'WOOKAFR_ENDPOINTS_CONFIG', {
  base: 'https://wookafr.center',
});
export const reloadWookafrEndpoints = siteEndpoints.reload;
export const getWookafrEndpoints = siteEndpoints.get;

const CONFIG_BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const VF_SLOTS = 3;
const VOSTFR_SLOTS = 3;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' };

const agent = makeDnsSafeAgent();

// Le domaine d'annuaire (wookafr.center) REDIRIGE (301) vers le domaine de contenu
// (wookafr.boston/.tel…) en PERDANT le ?s= -> il faut résoudre la cible d'abord et
// chercher dessus. Résolu une fois par la redirection, mis en cache.
let baseCache: { value: string; at: number } | null = null;
const BASE_TTL_MS = 30 * 60 * 1000;

async function resolveBase(): Promise<string> {
  if (baseCache && Date.now() - baseCache.at < BASE_TTL_MS) return baseCache.value;
  const cfg = CONFIG_BASE();
  try {
    const r = await axios.get(`${cfg}/`, {
      headers: HEADERS, timeout: REQ_TIMEOUT_MS, maxRedirects: 5,
      validateStatus: () => true, httpsAgent: agent, responseType: 'text', transformResponse: v => v,
    });
    // URL finale après redirections (node) -> origine du domaine de contenu.
    const finalUrl = (r.request?.res?.responseUrl || r.request?.responseURL || cfg) as string;
    const base = new URL(finalUrl).origin.replace(/\/+$/, '');
    baseCache = { value: base, at: Date.now() };
    return base;
  } catch { return cfg; }
}

export interface WookafrStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR | MULTI
  server: string;
  headers?: Record<string, string>;
}

/** GET texte ; suit les redirections (le domaine .center redirige vers .boston). */
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

// --- 1. Recherche ----------------------------------------------------------------

interface SearchItem { title: string; url: string; poster: string; isSeries: boolean; }

/** Items DooPlay : <a href="…/streaming/…"><img alt="Titre" data-src="…/<poster>.jpg">. */
function parseSearch(html: string): SearchItem[] {
  const out: SearchItem[] = [];
  const seen = new Set<string>();
  // <a href="…/streaming/<genre>/<slug>/"> <img … data-src="…tmdb…" alt="Titre" …>
  // (l'ordre alt/data-src varie -> on capture les attributs de l'<img> puis on extrait.)
  const rx = /<a href="(https?:\/\/[^"]*\/streaming\/([a-z-]+)\/[^"/]+\/)">\s*<img([^>]*)>/g;
  for (const m of html.matchAll(rx)) {
    const url = m[1], genre = m[2], img = m[3];
    if (seen.has(url) || /^(category|fuente|production|genre|years|country|calidad|network|source|slider)$/.test(genre)) continue;
    const title = img.match(/alt="([^"]*)"/)?.[1] || '';
    const posterUrl = img.match(/data-src="([^"]*image\.tmdb\.org[^"]*)"/)?.[1]
      || img.match(/src="([^"]*image\.tmdb\.org[^"]*)"/)?.[1] || '';
    if (!title) continue;
    seen.add(url);
    out.push({ title, url, poster: posterUrl.split('/').pop() || '', isSeries: /\/streaming\/series\//.test(url) });
  }
  return out;
}

async function search(base: string, title: string): Promise<SearchItem[]> {
  const html = await fetchText(`${base}/?s=${encodeURIComponent(title)}`, `${base}/`);
  return html ? parseSearch(html) : [];
}

// --- 2. Fiche -> URL de l'embed lecteurvideo -------------------------------------

const LECTEURVIDEO = /https?:\/\/lecteurvideo\.com\/embed\.php\?[^"']+/;

/** Film : l'iframe lecteurvideo de la fiche. */
async function filmEmbed(ficheUrl: string, referer: string): Promise<string | null> {
  const html = await fetchText(ficheUrl, referer);
  return html?.match(LECTEURVIDEO)?.[0]?.replace(/&amp;/g, '&') || null;
}

/** Série : fiche -> lien d'épisode saison-<S>-episode-<E> -> embed lecteurvideo. */
async function episodeEmbed(seriesUrl: string, season: number, episode: number, referer: string): Promise<string | null> {
  const html = await fetchText(seriesUrl, referer);
  if (!html) return null;
  const re = new RegExp(`href="(https?://[^"]*/streaming/episodes/[^"]*saison-${season}-episode-${episode}/)"`, 'i');
  const epUrl = html.match(re)?.[1];
  if (!epUrl) return null;
  const ep = await fetchText(epUrl, seriesUrl);
  return ep?.match(LECTEURVIDEO)?.[0]?.replace(/&amp;/g, '&') || null;
}

// --- 3. Embed lecteurvideo -> hôtes (base64) -------------------------------------

function hostsFromEmbed(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/showVideo\('([A-Za-z0-9+/=]+)'\s*,/g)) {
    let url = '';
    try { url = Buffer.from(m[1], 'base64').toString('utf8'); } catch { continue; }
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

// --- Langue / serveur ------------------------------------------------------------

function languageOf(ficheHtml: string): string {
  const t = ficheHtml.toLowerCase();
  const hasVostfr = /vostfr/.test(t);
  const hasVf = /\bvf\b|version fran/.test(t);
  if (hasVf && hasVostfr) return 'MULTI';
  if (hasVostfr) return 'VOSTFR';
  return 'VF'; // site FR : doublage par défaut
}

function serverName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return 'wookafr'; }
}

// --- Point d'entrée --------------------------------------------------------------

export async function getWookafrStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle?: string,
  season?: number,
  episode?: number,
  posters?: string[],
): Promise<WookafrStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const idKey = title.toLowerCase();
  const key = mediaType === 'series'
    ? `wookafr:${mode}:s:${idKey}:${season}:${episode}`
    : `wookafr:${mode}:m:${idKey}`;
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchWookafrStreams(extractorConfig, mediaType, title, originalTitle, season, episode, posters),
    { scope: 'wookafr', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchWookafrStreams(
  extractorConfig: ExtractorConfig,
  mediaType: 'movie' | 'series',
  title: string,
  originalTitle: string | undefined,
  season: number | undefined,
  episode: number | undefined,
  posters: string[] | undefined,
): Promise<WookafrStream[]> {
  const base = await resolveBase();
  const wanted = expandTitles([title, originalTitle].filter(Boolean) as string[]);
  const posterSet = new Set((posters || []).filter(Boolean));
  const wantSeries = mediaType === 'series';

  // 1. Recherche (titre FR d'abord), matching titre + POSTER TMDB (désambiguïsation exacte).
  let items: SearchItem[] = [];
  for (const t of [title, originalTitle].filter(Boolean) as string[]) {
    items = await search(base, t);
    if (items.length) break;
  }
  const candidates = items.filter(it => it.isSeries === wantSeries && titlesMatch(wanted, it.title));
  if (!candidates.length) { console.log(`[WookaFR] pas de correspondance pour "${title}"`); return []; }
  const hit = (posterSet.size ? candidates.find(c => posterSet.has(c.poster)) : candidates[0]);
  if (!hit) { console.log(`[WookaFR] "${title}" : aucun poster ne correspond`); return []; }

  // 2. Fiche -> embed lecteurvideo (film direct ou épisode mappé).
  const embedUrl = wantSeries
    ? await episodeEmbed(hit.url, season!, episode!, `${base}/`)
    : await filmEmbed(hit.url, `${base}/`);
  if (!embedUrl) { console.log(`[WookaFR] "${title}" : pas d'embed`); return []; }

  // 3. Embed lecteurvideo -> hôtes (base64).
  const embedHtml = await fetchText(embedUrl, hit.url);
  if (!embedHtml) return [];
  const usable = hostsFromEmbed(embedHtml).filter(u => detectExtractor(u));
  if (!usable.length) return [];

  // Langue déduite de la fiche (embed = hôtes sans marqueur de langue).
  const ficheHtml = (await fetchText(hit.url, `${base}/`)) || '';
  const language = languageOf(ficheHtml);

  // 4. Extraction en parallèle (bornée par VF+VOSTFR_SLOTS).
  const streams = (await Promise.all(usable.slice(0, VF_SLOTS + VOSTFR_SLOTS).map(async (embed): Promise<WookafrStream[]> => {
    const id = detectExtractor(embed) || undefined;
    const r = await extractStream(embed, extractorConfig, id);
    if (!r?.url) return [];
    if (r.format === 'hls' || /\.m3u8/i.test(r.url)) {
      const probe = await probeHlsResolution(r.url, r.headers || {});
      if (probe.dead) return [];
      return [{ url: r.url, quality: probe.quality || r.quality || 'HD', language, server: serverName(embed), headers: r.headers }];
    }
    return [{ url: r.url, quality: r.quality || 'HD', language, server: serverName(embed), headers: r.headers }];
  }))).flat();

  console.log(`[WookaFR] ${streams.length} flux pour "${title}"${wantSeries ? ` S${season}E${episode}` : ''}`);
  return streams;
}

/** Sonde de santé : la recherche répond-elle avec des fiches ? */
export async function wookafrProbe(): Promise<boolean> {
  return (await search(await resolveBase(), 'matrix')).length > 0;
}

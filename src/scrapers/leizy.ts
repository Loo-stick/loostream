import axios from 'axios';
import { extractStream, ExtractorConfig, detectExtractor } from '../extractors';
import { makeDnsSafeAgent } from '../dns-resolve';
import { cached } from '../cache';
import { titlesMatch, expandTitles } from '../matching';
import { probeHlsResolution } from '../hls-resolution';
import { makeEndpointConfig } from '../endpoint-config';

// leizy (leizy.fr) — FILMS + SÉRIES FR, VF + VOSTFR. App PHP maison (réseau bladred).
//
// Protocole (reversé le 2026-09-28) :
//   1. GET /api/search.php?q=<titre> -> JSON { results: [{ type: "film"|"serie",
//      title (FR), original, image (poster TMDB), url ("/pages/film.php?slug=…") }] }.
//   2. Film  : GET /pages/film.php?slug=<slug>  -> <a href="/player/index.php?type=film&id=<id>">.
//      Série : GET /pages/serie.php?slug=<slug> -> onglets `data-cinema-season-button="<sid>"`
//              (texte « Saison N ») + panneau `data-cinema-season-panel="<sid>"` listant des
//              <a class="cinema-episode" href="…type=episode&id=<epId>"><strong>N. Episode N</strong>.
//   3. AD-GATE (2 étapes) protège le player. Déverrouillage SANS voir la pub :
//        boucle : GET player (cookie + data-csrf + data-nonce)
//                 -> POST <data-action-url>  "action=gate_click&csrf_token=&gate_nonce="  -> {ok,step}
//        Le nonce ROTE à chaque étape (re-GET obligatoire). Après 2 clics : unlocked.
//   4. Le player déverrouillé porte le JSON des sources : { url, languageGroup: VF|VOSTFR, quality }.
//      Hôtes : vidmoly (HLS), my.mail.ru (mailru), video.sibnet.ru (sibnet) -> extracteurs locaux.
//      mailru/sibnet = LOCAL_ONLY (MediaFlow 502) -> `forceLocal`.

const siteEndpoints = makeEndpointConfig('leizy-endpoints.json', 'LEIZY_ENDPOINTS_CONFIG', {
  base: 'https://leizy.fr',
});
export const reloadLeizyEndpoints = siteEndpoints.reload;
export const getLeizyEndpoints = siteEndpoints.get;

const BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const VF_SLOTS = 3;
const VOSTFR_SLOTS = 3;
const GATE_STEPS_MAX = 4; // GET->POST->GET->POST->GET : au plus 4 tours de boucle

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' };

const agent = makeDnsSafeAgent();

export interface LeizyStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR
  server: string;
  headers?: Record<string, string>;
}

// --- Session à cookies (l'ad-gate garde son état dans un cookie) -----------------

interface Session { cookie: string; }

function mergeCookies(current: string, setCookie: string[] | undefined): string {
  if (!setCookie || !setCookie.length) return current;
  const jar = new Map<string, string>();
  for (const part of current.split('; ').filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const raw of setCookie) {
    const first = raw.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(
  url: string,
  opts: { sess?: Session; referer?: string; body?: string } = {},
): Promise<string | null> {
  try {
    const { data, status, headers } = await axios.request<string>({
      url,
      method: opts.body ? 'POST' : 'GET',
      data: opts.body,
      headers: {
        ...HEADERS,
        ...(opts.referer ? { Referer: opts.referer } : {}),
        ...(opts.sess?.cookie ? { Cookie: opts.sess.cookie } : {}),
        ...(opts.body
          ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
          : {}),
      },
      timeout: REQ_TIMEOUT_MS,
      responseType: 'text', transformResponse: (v: any) => v,
      validateStatus: () => true, maxRedirects: 4,
      httpsAgent: agent,
    });
    if (opts.sess) opts.sess.cookie = mergeCookies(opts.sess.cookie, headers?.['set-cookie'] as string[] | undefined);
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

// --- 1. Recherche ----------------------------------------------------------------

interface SearchItem { type: 'film' | 'serie'; title: string; slug: string; poster: string; }

async function search(title: string): Promise<SearchItem[]> {
  const json = await req(`${BASE()}/api/search.php?q=${encodeURIComponent(title)}`, { referer: `${BASE()}/` });
  if (!json) return [];
  let data: any;
  try { data = JSON.parse(json); } catch { return []; }
  const results = Array.isArray(data?.results) ? data.results : [];
  const out: SearchItem[] = [];
  for (const r of results) {
    const slug = String(r?.url || '').match(/slug=([^&]+)/)?.[1];
    const type = r?.type === 'serie' ? 'serie' : r?.type === 'film' ? 'film' : null;
    if (!slug || !type || !r?.title) continue;
    // `image` = poster TMDB (…/t/p/w500/<basename>) -> clé de rapprochement exact.
    const poster = String(r?.image || '').split('/').pop() || '';
    out.push({ type, title: String(r.title), slug: decodeURIComponent(slug), poster });
  }
  return out;
}

// --- 2. Fiche -> URL du player (+ tmdbId pour valider le FILM) --------------------

/**
 * Film : URL /player/index.php?type=film&id=<id> + l'id TMDB de la fiche
 * (`themoviedb.org/movie/<id>`), qui sert à REJETER les homonymes.
 */
async function resolveFilmFiche(slug: string): Promise<{ playerUrl: string; tmdbId: string } | null> {
  const html = await req(`${BASE()}/pages/film.php?slug=${encodeURIComponent(slug)}`, { referer: `${BASE()}/` });
  if (!html) return null;
  const rel = html.match(/\/player\/index\.php\?type=film[^"']+/)?.[0];
  if (!rel) return null;
  const tmdbId = html.match(/themoviedb\.org\/movie\/(\d+)/)?.[1] || '';
  return { playerUrl: `${BASE()}${rel.replace(/&amp;/g, '&')}`, tmdbId };
}

/** Série : mappe (saison, épisode) -> l'id d'épisode via les onglets/panneaux de saison. */
async function episodePlayerUrl(slug: string, season: number, episode: number): Promise<string | null> {
  const html = await req(`${BASE()}/pages/serie.php?slug=${encodeURIComponent(slug)}`, { referer: `${BASE()}/` });
  if (!html) return null;

  // Onglet de la saison voulue : bouton « Saison N » -> id interne de panneau.
  let seasonId = '';
  for (const m of html.matchAll(/data-cinema-season-button="(\d+)"[^>]*>\s*([^<]+)/g)) {
    const n = m[2].match(/(\d+)/)?.[1];
    if (n && Number(n) === season) { seasonId = m[1]; break; }
  }
  // Une seule saison sans numéro explicite -> on prend l'unique panneau.
  const panels = [...html.matchAll(/data-cinema-season-panel="(\d+)"/g)].map(m => m[1]);
  if (!seasonId) {
    if (season === 1 && panels.length === 1) seasonId = panels[0];
    else return null;
  }

  // Segment HTML du panneau de cette saison (jusqu'au panneau suivant).
  const start = html.search(new RegExp(`data-cinema-season-panel="${seasonId}"`));
  if (start < 0) return null;
  const rest = html.slice(start + 1);
  const nextPanel = rest.search(/data-cinema-season-panel="\d+"/);
  const segment = nextPanel < 0 ? rest : rest.slice(0, nextPanel);

  // <a class="cinema-episode" href="…id=<epId>"> … <strong>N. Episode N</strong>.
  for (const m of segment.matchAll(/<a class="cinema-episode"\s+href="([^"]*type=episode[^"]*id=(\d+)[^"]*)"[\s\S]*?<strong>\s*(\d+)\b/g)) {
    if (Number(m[3]) === episode) return `${BASE()}${m[1].replace(/&amp;/g, '&')}`;
  }
  return null;
}

// --- 3. Ad-gate : déverrouillage sans pub ----------------------------------------

interface RawSource { url: string; language: string; quality: string; }

/** Sources JSON présentes dans le player déverrouillé. */
function parseSources(html: string): RawSource[] {
  const out: RawSource[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/\{[^{}]*"language"[^{}]*\}/g)) {
    const o = m[0];
    const url = o.match(/"(https?:\/\/[^"]+)"/)?.[1];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const lg = /vostfr/i.test(o.match(/"languageGroup":"([^"]+)"/)?.[1] || '') ? 'VOSTFR' : 'VF';
    const quality = o.match(/"quality":"([^"]+)"/)?.[1] || 'Auto';
    out.push({ url, language: lg, quality });
  }
  return out;
}

/** GET player -> (2×) clic sur l'ad-gate -> sources. Une seule session pour toute la fiche. */
async function unlockSources(playerUrl: string, referer: string): Promise<RawSource[]> {
  const sess: Session = { cookie: '' };
  for (let i = 0; i < GATE_STEPS_MAX; i++) {
    const html = await req(playerUrl, { sess, referer });
    if (!html) return [];
    const sources = parseSources(html);
    if (sources.length) return sources;                  // déverrouillé
    if (!/class="ad-gate"|id="adGate"/.test(html)) return []; // ni gate ni sources
    const csrf = html.match(/data-csrf="([^"]+)"/)?.[1];
    const nonce = html.match(/data-nonce="([^"]+)"/)?.[1];
    const action = html.match(/data-action-url="([^"]+)"/)?.[1];
    if (!csrf || !nonce || !action) return [];
    await req(`${BASE()}${action.replace(/&amp;/g, '&').replace(/^https?:\/\/[^/]+/, '')}`, {
      sess, referer: playerUrl,
      body: `action=gate_click&csrf_token=${encodeURIComponent(csrf)}&gate_nonce=${encodeURIComponent(nonce)}`,
    });
  }
  return [];
}

// --- 4. Extraction + créneaux ----------------------------------------------------

function serverName(url: string): string {
  const h = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (/mail\.ru/i.test(h)) return 'mailru';
  if (/sibnet\.ru/i.test(h)) return 'sibnet';
  return h.replace(/^www\./, '').split('.')[0] || 'leizy';
}

/** Créneaux séparés par langue : une fiche massivement VF ne doit pas noyer les VOSTFR. */
function selectSources(sources: RawSource[]): RawSource[] {
  const usable = sources.filter(s => detectExtractor(s.url));
  return [
    ...usable.filter(s => s.language === 'VF').slice(0, VF_SLOTS),
    ...usable.filter(s => s.language === 'VOSTFR').slice(0, VOSTFR_SLOTS),
  ];
}

// --- Point d'entrée --------------------------------------------------------------

export async function getLeizyStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle?: string,
  year?: number,
  season?: number,
  episode?: number,
  tmdbId?: string,
  posters?: string[],
): Promise<LeizyStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  // Clé keyée sur tmdbId (identité exacte) quand on l'a, sinon titre.
  const idKey = tmdbId || title.toLowerCase();
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = mediaType === 'series'
    ? `leizy:${mode}:s:${idKey}:${season}:${episode}`
    : `leizy:${mode}:m:${idKey}`;
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchLeizyStreams(extractorConfig, mediaType, title, originalTitle, year, season, episode, tmdbId, posters),
    { scope: 'leizy', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

// leizy attache parfois une VIDÉO d'une AUTRE année à la bonne fiche (métadonnée
// John Wick « Ballerina 2025 » posée sur la vidéo « Ballerina (2023) »). Le JSON de
// métadonnées mail.ru porte le titre réel (meta.title = « Ballerina (2023) - FILM VF »)
// -> on en lit l'année pour rejeter tout le résultat si elle ne colle pas. Même chemin
// que l'extracteur mailru (embed -> metadataUrl -> JSON), donc fiable. null si illisible.
async function mailruTitleYear(embedUrl: string): Promise<number | null> {
  try {
    const page = await req(embedUrl, { referer: `${BASE()}/` });
    if (!page) return null;
    const m = page.match(/metadataUrl["']?\s*[:=]\s*["']([^"']+)/);
    if (!m) return null;
    const metaUrl = m[1].startsWith('//') ? `https:${m[1]}` : new URL(m[1], embedUrl).toString();
    const { data } = await axios.get(metaUrl, {
      headers: { ...HEADERS, Referer: embedUrl }, timeout: REQ_TIMEOUT_MS,
      validateStatus: () => true, httpsAgent: agent,
    });
    const title = String(data?.meta?.title || '');
    const y = title.match(/\((\d{4})\)/)?.[1] || title.match(/\b(?:19|20)\d\d\b/)?.[0];
    return y ? Number(y) : null;
  } catch { return null; }
}

const MAX_CANDIDATES = 4; // fiches film ouvertes pour lever un homonyme

async function fetchLeizyStreams(
  extractorConfig: ExtractorConfig,
  mediaType: 'movie' | 'series',
  title: string,
  originalTitle: string | undefined,
  year: number | undefined,
  season?: number,
  episode?: number,
  tmdbId?: string,
  posters?: string[],
): Promise<LeizyStream[]> {
  const wanted = expandTitles([title, originalTitle].filter(Boolean) as string[]);
  const wantType = mediaType === 'series' ? 'serie' : 'film';
  const posterSet = new Set((posters || []).filter(Boolean));

  // 1. Recherche (titre FR d'abord — le site indexe en FR), matching token-set strict.
  let items: SearchItem[] = [];
  for (const t of [title, originalTitle].filter(Boolean) as string[]) {
    items = await search(t);
    if (items.length) break;
  }
  const candidates = items.filter(it => it.type === wantType && titlesMatch(wanted, it.title));
  if (!candidates.length) {
    console.log(`[Leizy] pas de correspondance pour "${title}"`);
    return [];
  }

  // 2. Désambiguïsation EXACTE (évite le mauvais homonyme) + URL du player.
  let slug = '', playerUrl: string | null = null;
  if (mediaType === 'series') {
    // Séries : la fiche n'expose pas d'id TMDB -> on rapproche par le POSTER TMDB
    // renvoyé dans la recherche. Sans poster connu (repli Cinemeta), on retombe sur
    // le 1er match de titre.
    const hit = (posterSet.size ? candidates.find(c => posterSet.has(c.poster)) : candidates[0]);
    if (!hit) { console.log(`[Leizy] "${title}" : aucun poster ne correspond (série)`); return []; }
    slug = hit.slug;
    playerUrl = await episodePlayerUrl(slug, season!, episode!);
  } else {
    // Films : la fiche porte l'id TMDB -> on ouvre les candidats (poster-match d'abord)
    // et on garde celui dont l'id TMDB == demandé. Sans id demandé (repli), 1er candidat.
    const ordered = posterSet.size
      ? [...candidates].sort((a, b) => Number(posterSet.has(b.poster)) - Number(posterSet.has(a.poster)))
      : candidates;
    for (const c of ordered.slice(0, MAX_CANDIDATES)) {
      const fiche = await resolveFilmFiche(c.slug);
      if (!fiche) continue;
      if (tmdbId && fiche.tmdbId && fiche.tmdbId !== tmdbId) continue; // homonyme -> rejeté
      slug = c.slug; playerUrl = fiche.playerUrl; break;
    }
    if (!playerUrl && tmdbId) { console.log(`[Leizy] "${title}" : aucun film ne correspond au tmdbId ${tmdbId}`); return []; }
  }
  if (!playerUrl) return [];
  const referer = `${BASE()}/pages/${wantType}.php?slug=${encodeURIComponent(slug)}`;

  // 3. Ad-gate -> sources (une seule fois pour la fiche).
  const sources = selectSources(await unlockSources(playerUrl, referer));
  if (!sources.length) return [];

  // 3bis. Anti-mislabel : la fiche peut être juste (bon tmdbId) mais la VIDÉO d'une
  // autre année (leizy pose « Ballerina 2025 » sur la vidéo « Ballerina (2023) »).
  // Le titre mail.ru porte l'année réelle -> si elle diverge de >1 an, toute l'entrée
  // leizy est mislabellée : on la rejette (mieux vaut rien que le mauvais film).
  if (year) {
    const mr = sources.find(s => /mail\.ru/i.test(s.url));
    if (mr) {
      const vy = await mailruTitleYear(mr.url);
      if (vy && Math.abs(vy - year) > 1) {
        console.log(`[Leizy] "${title}" : vidéo mal étiquetée (${vy} ≠ ${year} demandé) -> rejetée`);
        return [];
      }
    }
  }

  // 4. Un extracteur par source retenue, EN PARALLÈLE.
  const streams = (await Promise.all(sources.map(async (s): Promise<LeizyStream[]> => {
    const id = detectExtractor(s.url) || undefined;
    const r = await extractStream(s.url, extractorConfig, id);
    if (!r?.url) return [];
    if (r.format === 'hls' || /\.m3u8/i.test(r.url)) {
      const probe = await probeHlsResolution(r.url, r.headers || {});
      if (probe.dead) return [];
      return [{ url: r.url, quality: probe.quality || r.quality || 'HD', language: s.language, server: serverName(s.url), headers: r.headers }];
    }
    return [{ url: r.url, quality: r.quality || 'HD', language: s.language, server: serverName(s.url), headers: r.headers }];
  }))).flat();

  console.log(`[Leizy] ${streams.length} flux pour "${title}"${mediaType === 'series' ? ` S${season}E${episode}` : ''}`);
  return streams;
}

/** Sonde de santé : la recherche répond-elle avec des fiches ? */
export async function leizyProbe(): Promise<boolean> {
  return (await search('ballerina')).length > 0;
}

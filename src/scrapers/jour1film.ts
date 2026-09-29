import { extractStream, ExtractorConfig, detectExtractor } from '../extractors';
import { curlFetch, curlJson } from '../curl-fetch';
import { cached } from '../cache';
import { titlesMatch, expandTitles } from '../matching';
import { probeHlsResolution } from '../hls-resolution';
import { makeEndpointConfig } from '../endpoint-config';

// 1jour1film (annuaire « wow-films ») — FILMS + SÉRIES FR, VF + VOSTFR. WordPress
// **DooPlay STANDARD** (thème dooplay 2.5.5) sur un domaine daté rotatif
// (1jour1film<MMYY>.cyou). On gère déjà DooPlay (coflix).
//
// Protocole (reversé le 2026-09-29) :
//   Recherche : la page /?s= est protégée par Cloudflare -> on passe par l'API WP REST
//   (non gatée, sans nonce) :
//     - films  : GET /wp-json/wp/v2/movies?search=<titre>   -> [{id, title, slug, link, dtyear}]
//               (le slug porte l'année : « colony-vf-2026 »)
//     - séries : GET /wp-json/wp/v2/episodes?search=<titre> -> [{id, title « … SxxExx »}]
//   Résolution : POST /wp-admin/admin-ajax.php
//     action=doo_player_ajax&post=<id>&nume=<1..N>&type=<movie|tv>
//     -> {"embed_url":"https://<hôte>/…","type":"iframe"} (nume vide = fin de liste)
//   Hôtes vus : vidara (WaveWatch), luluvdo, vidmoly, streamwish… -> extracteurs locaux ;
//   upbolt/cetaitmieuxavant inconnus -> ignorés.
//   Désambiguïsation FILM : id TMDB lu dans la fiche (themoviedb.org/movie/<id>) +
//   année du slug. SÉRIE : titre du show + SxxExx exact.

const siteEndpoints = makeEndpointConfig('jour1film-endpoints.json', 'JOUR1FILM_ENDPOINTS_CONFIG', {
  base: 'https://1jour1film0926.cyou',
});
export const reloadJour1filmEndpoints = siteEndpoints.reload;
export const getJour1filmEndpoints = siteEndpoints.get;

const CONFIG_BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const BASE_TTL_MS = 30 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const MAX_NUME = 6;         // serveurs sondés par titre (doo_player_ajax)
const MAX_CANDIDATES = 3;   // fiches film ouvertes pour lever un homonyme

export interface Jour1filmStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR | MULTI
  server: string;
  headers?: Record<string, string>;
}

// Le site est derrière un mur Cloudflare qui JUGE L'EMPREINTE TLS : toute requête Node
// (axios) reçoit « Just a moment » (403), curl passe. On délègue donc au transport curl
// (cf. curl-fetch, comme nkstrm). Les EXTRACTEURS tapent d'autres hôtes (vidara/luluvdo/
// vidmoly) non gatés -> ils gardent axios.
async function fetchText(url: string, referer?: string, body?: string): Promise<string | null> {
  const r = await curlFetch(url, {
    method: body ? 'POST' : 'GET', body,
    headers: {
      ...(referer ? { Referer: referer } : {}),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' } : {}),
    },
    timeoutMs: REQ_TIMEOUT_MS,
  });
  if (r.status < 200 || r.status >= 400 || !r.body) return null;
  return r.body;
}

async function fetchJson<T = any>(url: string, referer?: string): Promise<T | null> {
  const r = await curlJson<T>(url, { headers: referer ? { Referer: referer } : {}, timeoutMs: REQ_TIMEOUT_MS });
  return r.status >= 200 && r.status < 300 ? r.data : null;
}

// --- Découverte du domaine (daté, rotatif) --------------------------------------
// Le domaine suit 1jour1film<MM><YY>.cyou. On essaie le domaine du config puis des
// candidats datés (mois courant/voisins), en validant par l'API WP REST. Le bon est
// mis en cache 30 min ; éditable à chaud via jour1film-endpoints.json.

let baseCache: { value: string; at: number } | null = null;

function datedCandidates(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (const delta of [0, 1, -1, 2]) {
    const d = new Date(now.getFullYear(), now.getMonth() + delta, 1);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    out.push(`https://1jour1film${mm}${yy}.cyou`);
  }
  return out;
}

/** L'API /wp-json/wp/v2/movies répond-elle en JSON sur cette base ? */
async function baseAlive(base: string): Promise<boolean> {
  const d = await fetchJson<any[]>(`${base}/wp-json/wp/v2/types`, `${base}/`);
  return !!d && typeof d === 'object';
}

async function resolveBase(): Promise<string> {
  if (baseCache && Date.now() - baseCache.at < BASE_TTL_MS) return baseCache.value;
  const tried = [CONFIG_BASE(), ...datedCandidates()].filter((v, i, a) => a.indexOf(v) === i);
  for (const b of tried) {
    if (await baseAlive(b)) { baseCache = { value: b, at: Date.now() }; return b; }
  }
  return CONFIG_BASE(); // dernier recours : on tente quand même le config
}

// --- Recherche (WP REST) ---------------------------------------------------------

interface Movie { id: number; title: string; slug: string; link: string; dtquality: number[]; }
interface Episode { id: number; title: string; dtquality: number[]; }

function qualityIds(o: any): number[] {
  return Array.isArray(o?.dtquality) ? o.dtquality.map(Number).filter((n: number) => n > 0) : [];
}

async function searchMovies(base: string, title: string): Promise<Movie[]> {
  const d = await fetchJson<any[]>(`${base}/wp-json/wp/v2/movies?search=${encodeURIComponent(title)}&per_page=6`, `${base}/`);
  if (!Array.isArray(d)) return [];
  return d.map(m => ({ id: m.id, title: String(m?.title?.rendered || ''), slug: String(m?.slug || ''), link: String(m?.link || ''), dtquality: qualityIds(m) }))
    .filter(m => m.id && m.title);
}

async function searchEpisodes(base: string, title: string): Promise<Episode[]> {
  const d = await fetchJson<any[]>(`${base}/wp-json/wp/v2/episodes?search=${encodeURIComponent(title)}&per_page=30`, `${base}/`);
  if (!Array.isArray(d)) return [];
  return d.map(e => ({ id: e.id, title: String(e?.title?.rendered || ''), dtquality: qualityIds(e) })).filter(e => e.id && e.title);
}

// --- Langue (taxonomie dtquality) -----------------------------------------------
// DooPlay range la langue dans la taxonomie « dtquality » (« VF », « VOSTFR »,
// « VF+VOSTFR HD », « VO »…), pas dans le titre (qui affiche toujours « VF HD »,
// peu fiable — cf. Unabomber étiqueté « VF » mais servi en VOSTFR). On résout la
// taxonomie (id -> nom), mise en cache, et on en déduit la langue du titre.

let qualityMapCache: { base: string; map: Map<number, string>; at: number } | null = null;

async function loadQualityMap(base: string): Promise<Map<number, string>> {
  if (qualityMapCache && qualityMapCache.base === base && Date.now() - qualityMapCache.at < BASE_TTL_MS) {
    return qualityMapCache.map;
  }
  const d = await fetchJson<any[]>(`${base}/wp-json/wp/v2/dtquality?per_page=100`, `${base}/`);
  const map = new Map<number, string>();
  if (Array.isArray(d)) for (const t of d) if (t?.id) map.set(Number(t.id), String(t?.name || '').toLowerCase());
  qualityMapCache = { base, map, at: Date.now() };
  return map;
}

function languageFrom(ids: number[], map: Map<number, string>): string {
  const joined = ids.map(id => map.get(id) || '').join(' ');
  const hasVf = /\bvf\b/.test(joined);
  const hasVostfr = /vostfr/.test(joined);
  const hasVo = /\bvo\b/.test(joined) && !hasVostfr;
  if (hasVf && hasVostfr) return 'MULTI';
  if (hasVostfr) return 'VOSTFR';
  if (hasVo) return 'VO';
  return 'VF'; // site FR : doublage par défaut si la taxonomie ne dit rien
}

// --- Résolution des serveurs (doo_player_ajax) ----------------------------------

async function servers(base: string, postId: number, type: 'movie' | 'tv', referer: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let nume = 1; nume <= MAX_NUME; nume++) {
    const raw = await fetchText(
      `${base}/wp-admin/admin-ajax.php`, referer,
      `action=doo_player_ajax&post=${postId}&nume=${nume}&type=${type}`,
    );
    if (!raw) break;
    let embed = '';
    try { embed = JSON.parse(raw)?.embed_url || ''; } catch { embed = raw.match(/"embed_url":"([^"]+)"/)?.[1]?.replace(/\\\//g, '/') || ''; }
    if (!embed) break;              // nume vide -> fin de la liste
    if (seen.has(embed)) continue;
    seen.add(embed);
    out.push(embed);
  }
  return out;
}

// --- Serveur ---------------------------------------------------------------------

function serverName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return 'jour1film'; }
}

// --- Point d'entrée --------------------------------------------------------------

export async function getJour1filmStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle?: string,
  year?: number,
  season?: number,
  episode?: number,
  tmdbId?: string,
): Promise<Jour1filmStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const idKey = tmdbId || title.toLowerCase();
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = mediaType === 'series'
    ? `jour1film:${mode}:s:${idKey}:${season}:${episode}`
    : `jour1film:${mode}:m:${idKey}`;
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchStreams(extractorConfig, mediaType, title, originalTitle, year, season, episode, tmdbId),
    { scope: 'jour1film', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchStreams(
  extractorConfig: ExtractorConfig,
  mediaType: 'movie' | 'series',
  title: string,
  originalTitle: string | undefined,
  year: number | undefined,
  season: number | undefined,
  episode: number | undefined,
  tmdbId: string | undefined,
): Promise<Jour1filmStream[]> {
  const base = await resolveBase();
  const wanted = expandTitles([title, originalTitle].filter(Boolean) as string[]);
  const titleQueries = [...new Set([title, originalTitle].filter(Boolean) as string[])];

  let postId = 0, type: 'movie' | 'tv' = 'movie', referer = `${base}/`, dtq: number[] = [];

  if (mediaType === 'series') {
    // Épisodes : titre du show + SxxExx exact.
    type = 'tv';
    const se = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    let eps: Episode[] = [];
    for (const q of titleQueries) { eps = await searchEpisodes(base, q); if (eps.length) break; }
    const hit = eps.find(e => new RegExp(se, 'i').test(e.title)
      && titlesMatch(wanted, e.title.replace(/\bS\d+E\d+\b.*$/i, '').trim()));
    if (!hit) { console.log(`[1Jour1Film] "${title}" ${se} : pas d'épisode`); return []; }
    postId = hit.id; dtq = hit.dtquality;
  } else {
    // Films : titre + (année du slug) et id TMDB de la fiche pour lever les homonymes.
    type = 'movie';
    let movies: Movie[] = [];
    for (const q of titleQueries) { movies = await searchMovies(base, q); if (movies.length) break; }
    const candidates = movies.filter(m => titlesMatch(wanted, m.title));
    if (!candidates.length) { console.log(`[1Jour1Film] pas de correspondance pour "${title}"`); return []; }

    for (const c of candidates.slice(0, MAX_CANDIDATES)) {
      // Année dans le slug (« colony-vf-2026 ») : rejette vite le mauvais millésime.
      const sy = c.slug.match(/(?:^|-)(\d{4})(?:-|$)/)?.[1];
      if (year && sy && Math.abs(Number(sy) - year) > 1) continue;
      // Id TMDB de la fiche (exact) quand on l'a des deux côtés.
      if (tmdbId) {
        const fiche = await fetchText(c.link, `${base}/`);
        const ftmdb = fiche?.match(/themoviedb\.org\/movie\/(\d+)/)?.[1];
        if (ftmdb && ftmdb !== tmdbId) continue;
      }
      postId = c.id; referer = c.link; dtq = c.dtquality; break;
    }
    if (!postId) { console.log(`[1Jour1Film] "${title}" : aucun film ne correspond (année/tmdbId ${tmdbId || '?'})`); return []; }
  }

  // Résolution des serveurs + extraction en parallèle.
  const embeds = await servers(base, postId, type, referer);
  if (!embeds.length) return [];
  const language = languageFrom(dtq, await loadQualityMap(base));

  const streams = (await Promise.all(embeds.map(async (embed): Promise<Jour1filmStream[]> => {
    const id = detectExtractor(embed);
    if (!id) return [];                 // hôte inconnu (upbolt, cetaitmieuxavant…) -> ignoré
    const r = await extractStream(embed, extractorConfig, id);
    if (!r?.url) return [];
    if (r.format === 'hls' || /\.m3u8/i.test(r.url)) {
      const probe = await probeHlsResolution(r.url, r.headers || {});
      if (probe.dead) return [];
      return [{ url: r.url, quality: probe.quality || r.quality || 'HD', language, server: serverName(embed), headers: r.headers }];
    }
    return [{ url: r.url, quality: r.quality || 'HD', language, server: serverName(embed), headers: r.headers }];
  }))).flat();

  console.log(`[1Jour1Film] ${streams.length} flux pour "${title}"${mediaType === 'series' ? ` S${season}E${episode}` : ''}`);
  return streams;
}

/** Sonde de santé : l'API WP REST répond et la recherche renvoie un film. */
export async function jour1filmProbe(): Promise<boolean> {
  const base = await resolveBase();
  return (await searchMovies(base, 'the')).length > 0;
}

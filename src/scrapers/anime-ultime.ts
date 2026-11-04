import axios from 'axios';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { makeEndpointConfig } from '../endpoint-config';
import { makeDnsSafeAgent } from '../dns-resolve';
import { titlesMatch, expandTitles } from '../matching';

// Anime-Ultime (anime-ultime.net) — anime FR VOSTFR (+ drama/tokusatsu/OST), gros
// back-catalogue fansub, self-hosté (OVH). Coquille JWPlayer Flash d'époque mais flux
// MP4 modernes. Protocole reversé le 2026-11-04, SANS login ni captcha :
//
//   Recherche : POST /search-0-1  body `search=<titre>` -> page HTML avec des liens
//     `file-0-1/<id>-<slug>` (<id> = l'id de fiche ; le slug est en romaji). La recherche
//     « suggest » (searchSuggest.php) renvoie un id DIFFÉRENT (index interne) INUTILISABLE
//     -> on passe par la page de résultats plein-texte.
//   Playlist  : GET /playlist-<id>.xml -> MRSS listant TOUS les épisodes dans l'ordre,
//     chacun avec un <title> (« <Titre> NN ») et une URL `stream-<mediaId>.mp4`.
//   Flux      : GET /stream-<mediaId>.mp4 -> 302 (sans auth) vers une URL CDN SIGNÉE et
//     HORODATÉE sur strhq-fr.anime-ultime.net -> MP4 direct, Range supporté. On renvoie
//     l'URL STABLE `stream-<mediaId>.mp4` (pas l'URL signée) : elle re-forge un 302 frais à
//     chaque appel -> pas d'expiration de jeton à gérer, le proxy suit le 302.
//
// LANGUE : catalogue massivement VOSTFR (fansub). Pas de signal de langue fiable par
// épisode -> on étiquette VOSTFR. applyMultiAudio ne touche pas un MP4 mono-piste.
// SAISONS : chaque saison/OAV/film est une FICHE séparée (id distinct). On mappe le titre
// (romaji + alts AniList) sur une fiche, puis l'épisode par son numéro dans la playlist.

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;

const siteEndpoints = makeEndpointConfig('anime-ultime-endpoints.json', 'ANIMEULTIME_ENDPOINTS_CONFIG', {
  base: 'https://www.anime-ultime.net',
});
export const reloadAnimeUltimeEndpoints = siteEndpoints.reload;
export const getAnimeUltimeEndpoints = siteEndpoints.get;
const BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const agent = makeDnsSafeAgent();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface AnimeUltimeStream {
  url: string;
  quality: string;
  language: string;   // VOSTFR (défaut) | VF
  server: string;
  headers?: Record<string, string>;
}

function slugify(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// --- Recherche : titre -> id de fiche ----------------------------------------------

interface Candidate { id: string; slug: string; }

async function search(title: string): Promise<Candidate[]> {
  try {
    const { data, status } = await axios.post<string>(
      `${BASE()}/search-0-1`,
      `search=${encodeURIComponent(title)}`,
      {
        headers: {
          'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Language': 'fr-FR,fr;q=0.9', Referer: `${BASE()}/`,
        },
        timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
        validateStatus: () => true, httpsAgent: agent,
      },
    );
    if (status < 200 || status >= 300 || typeof data !== 'string') return [];
    const out: Candidate[] = [];
    const seen = new Set<string>();
    // Liens de résultats : file-0-1/<id>-<slug>
    for (const m of data.matchAll(/file-0-1\/(\d+)-([A-Za-z0-9-]+)/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ id: m[1], slug: m[2].toLowerCase() });
    }
    return out;
  } catch { return []; }
}

/** id de fiche par match de slug (exact d'abord, puis token-set), sur plusieurs titres. */
async function matchAnime(titles: string[]): Promise<string | null> {
  const wantedSlugs = new Set(titles.map(slugify).filter(Boolean));
  const wanted = expandTitles(titles);
  for (const title of titles) {
    const cands = await search(title);
    if (!cands.length) continue;
    // 1. Slug EXACT (les slugs du site sont en romaji, comme nos alts AniList).
    for (const c of cands) if (wantedSlugs.has(c.slug)) return c.id;
    // 2. Token-set sur le slug « déslugifié » (tolère ordre/ponctuation).
    for (const c of cands) if (titlesMatch(wanted, c.slug.replace(/-/g, ' '))) return c.id;
  }
  return null;
}

// --- Playlist : id de fiche -> épisodes --------------------------------------------

interface Episode { num: number | null; mediaId: string; }

/** Dernier entier d'un titre (« Girls und Panzer 01 » -> 1). Null si aucun (film/OAV). */
function trailingNumber(title: string): number | null {
  const nums = title.match(/\d+/g);
  return nums && nums.length ? Number(nums[nums.length - 1]) : null;
}

async function getPlaylist(id: string): Promise<Episode[]> {
  try {
    const { data, status } = await axios.get<string>(`${BASE()}/playlist-${id}.xml`, {
      headers: { 'User-Agent': UA, Referer: `${BASE()}/` },
      timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
      validateStatus: () => true, httpsAgent: agent,
    });
    if (status < 200 || status >= 300 || typeof data !== 'string') return [];
    const out: Episode[] = [];
    for (const item of data.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = item[1];
      const mediaId = block.match(/stream-(\d+)\.mp4/)?.[1];
      if (!mediaId) continue;
      const title = block.match(/<title>([^<]*)<\/title>/)?.[1] || '';
      out.push({ num: trailingNumber(title), mediaId });
    }
    return out;
  } catch { return []; }
}

/** Épisode demandé -> mediaId : match par numéro, repli sur la position (Nème item). */
function pickEpisode(eps: Episode[], episode: number): string | null {
  if (!eps.length) return null;
  const byNum = eps.find(e => e.num === episode);
  if (byNum) return byNum.mediaId;
  if (eps.length === 1) return eps[0].mediaId;        // film/OAV unique
  return eps[episode - 1]?.mediaId || null;           // repli positionnel
}

// --- Point d'entrée ----------------------------------------------------------------

export async function getAnimeUltimeStreams(
  id: string,
  mediaType: 'movie' | 'series',
  _extractorConfig: unknown,
  season: number | undefined,
  episode: number | undefined,
  title: string,
  originalTitle?: string,
  altTitles: string[] = [],
): Promise<AnimeUltimeStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && !episode) return [];
  const e = mediaType === 'series' ? episode! : 1;
  const key = `animeultime:${id}:${season || 1}:${e}`;
  const titles = [...new Set([...altTitles, originalTitle, title].filter(Boolean) as string[])];
  return cached(
    key, STREAMS_TTL_MS,
    async () => { const r = await fetchAnimeUltimeStreams(titles, e); return applyMultiAudio(r); },
    { scope: 'animeultime', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchAnimeUltimeStreams(titles: string[], episode: number): Promise<AnimeUltimeStream[]> {
  const id = await matchAnime(titles);
  if (!id) { console.log(`[AnimeUltime] pas de correspondance pour "${titles[0]}"`); return []; }

  const eps = await getPlaylist(id);
  const mediaId = pickEpisode(eps, episode);
  if (!mediaId) { console.log(`[AnimeUltime] épisode ${episode} introuvable (fiche ${id})`); return []; }

  // URL stable (re-forge un 302 frais à chaque appel) -> le proxy suit le 302 vers le CDN signé.
  const url = `${BASE()}/stream-${mediaId}.mp4`;
  console.log(`[AnimeUltime] 1 flux pour "${titles[0]}" (fiche ${id}, ep ${episode})`);
  return [{ url, quality: 'HD', language: 'VOSTFR', server: 'animeultime', headers: { Referer: `${BASE()}/` } }];
}

/** Sonde de santé : la recherche répond-elle avec des fiches ? */
export async function animeUltimeProbe(): Promise<boolean> {
  return (await search('naruto')).length > 0;
}

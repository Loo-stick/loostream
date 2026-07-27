import axios from 'axios';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';

// Nabistream — dramas coréens & asiatiques VOSTFR (nabistream.mom). Provider Onyx
// NabistreamProvider. API ouverte (Payload CMS), keyée par id TMDB, sans auth ni
// Cloudflare. Renvoie un HLS master AUTONOME (audio + vidéo mux) + sous-titres FR.
//
// Flow :
//   Film   : /proxy/api/movies?where[tmdbId][equals]={tmdb} -> doc.id
//   Série  : /proxy/api/shows?where[tmdbId][equals]={tmdb}  -> show.id
//            /proxy/api/episodes?where[show][equals]={show.id}
//              &where[seasonNumber][equals]={s}&where[episodeNumber][equals]={e} -> ep.id
//   Stream : /api/stream/{contentId} -> { video.url (index.m3u8), subtitles[] }

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;

const siteEndpoints = makeEndpointConfig('nabistream-endpoints.json', 'NABISTREAM_ENDPOINTS_CONFIG', {
  base: 'https://nabistream.mom',
});
export const reloadNabistreamEndpoints = siteEndpoints.reload;
export const getNabistreamEndpoints = siteEndpoints.get;
const BASE = () => siteEndpoints.get().base;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};

export interface NabistreamStream {
  url: string;         // HLS master (index.m3u8), audio+vidéo autonome
  quality: string;     // 1080p / 720p / HD
  language: string;    // VOSTFR (audio original + sous-titres FR)
  server: string;      // nabistream
  subtitles: { lang: string; url: string }[];
}

async function getJson<T = any>(url: string): Promise<T | null> {
  try {
    const { data, status } = await axios.get(url, { headers: HEADERS, timeout: REQ_TIMEOUT_MS, validateStatus: () => true });
    if (status < 200 || status >= 300 || !data || typeof data !== 'object') return null;
    return data as T;
  } catch {
    return null;
  }
}

// Premier doc d'une collection Payload CMS filtrée par id TMDB.
async function findByTmdb(collection: 'movies' | 'shows', tmdbId: string): Promise<any | null> {
  const data = await getJson<{ docs?: any[] }>(
    `${BASE()}/proxy/api/${collection}?where%5BtmdbId%5D%5Bequals%5D=${encodeURIComponent(tmdbId)}`
  );
  return data?.docs?.[0] || null;
}

async function findEpisode(showId: string, season: number, episode: number): Promise<any | null> {
  const data = await getJson<{ docs?: any[] }>(
    `${BASE()}/proxy/api/episodes?where%5Bshow%5D%5Bequals%5D=${encodeURIComponent(showId)}` +
    `&where%5BseasonNumber%5D%5Bequals%5D=${season}&where%5BepisodeNumber%5D%5Bequals%5D=${episode}`
  );
  return data?.docs?.[0] || null;
}

interface StreamResp {
  video?: { url?: string };
  subtitles?: { lang?: string; url?: string }[];
}

// Stremio matche les sous-titres sur des codes ISO 639-2 (3 lettres). L'API rend
// du 2 lettres ("fr"/"en") que Stremio ignore silencieusement — on convertit.
const LANG_2_TO_3: Record<string, string> = {
  fr: 'fre', en: 'eng', ko: 'kor', ja: 'jpn', zh: 'chi', es: 'spa',
  de: 'deu', it: 'ita', pt: 'por', ru: 'rus', ar: 'ara', th: 'tha',
};
function iso3(lang: string): string {
  const l = (lang || '').toLowerCase();
  return LANG_2_TO_3[l] || l; // déjà en 3 lettres (ou inconnu) -> tel quel
}

// Résolution réelle depuis le master HLS (RESOLUTION=WxH -> tag qualité). Un seul
// fetch : valide aussi que le flux est vivant. 'HD' en repli si illisible.
async function masterQuality(masterUrl: string): Promise<string> {
  try {
    const { data } = await axios.get<string>(masterUrl, {
      headers: HEADERS, timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
    });
    const h = String(data).match(/RESOLUTION=\d+x(\d+)/i);
    if (!h) return 'HD';
    const height = Number(h[1]);
    if (height >= 2000) return '4K';
    if (height >= 1400) return '1440p';
    if (height >= 1000) return '1080p';
    if (height >= 700) return '720p';
    if (height >= 460) return '480p';
    return 'HD';
  } catch {
    return 'HD';
  }
}

export async function getNabistreamStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<NabistreamStream[]> {
  if (!tmdbId) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const key = mediaType === 'series'
    ? `nabistream:series:${tmdbId}:${season}:${episode}`
    : `nabistream:movie:${tmdbId}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchNabistreamStreams(tmdbId, mediaType, season, episode),
    { scope: 'nabistream', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchNabistreamStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<NabistreamStream[]> {
  // Résout l'id de contenu (film ou épisode) à partir de l'id TMDB.
  let contentId: string | null = null;
  if (mediaType === 'movie') {
    const movie = await findByTmdb('movies', tmdbId);
    contentId = movie?.id || null;
  } else {
    const show = await findByTmdb('shows', tmdbId);
    if (show?.id) {
      const ep = await findEpisode(show.id, season!, episode!);
      contentId = ep?.id || null;
    }
  }
  if (!contentId) {
    console.log(`[Nabistream] Hors catalogue (tmdb ${tmdbId})`);
    return [];
  }

  const resp = await getJson<StreamResp>(`${BASE()}/api/stream/${encodeURIComponent(contentId)}`);
  const videoUrl = resp?.video?.url;
  if (!videoUrl || !/^https?:\/\//.test(videoUrl)) {
    console.log(`[Nabistream] Pas de video.url (tmdb ${tmdbId})`);
    return [];
  }

  const subtitles = (resp?.subtitles || [])
    .filter(s => s?.url && /^https?:\/\//.test(s.url) && s.lang)
    .map(s => ({ lang: iso3(s.lang as string), url: s.url as string }));

  const quality = await masterQuality(videoUrl);
  console.log(`[Nabistream] tmdb ${tmdbId} -> ${quality} VOSTFR (${subtitles.length} sub)`);
  return [{ url: videoUrl, quality, language: 'VOSTFR', server: 'nabistream', subtitles }];
}

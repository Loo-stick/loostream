import axios from 'axios';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';

// StreamFlix V2 (streamflix.mom) — API REST publique keyée TMDB, zéro auth.
//   Film  : GET /api/movies/{tmdbId}            -> { id (interne), title, video_quality, has_video }
//           GET /api/movies/{id}/video-url      -> { directUrl, isHls }
//   Série : GET /api/series/{tmdbId}            -> { id (interne), name }
//           GET /api/series/{id}/season/{s}/episode/{e}/video-url -> { directUrl, isHls }
// Le directUrl est un MP4 progressif sur citron-edge.lol (302 -> cheksum.lol). Contenu
// VF (chemin .../series/VF/...). L'ANCIENNE app (api.streamflix.app) pointait des CDN
// morts -> réécrit pour la V2. La base est éditable dans l'admin (hot-reload) : TOUT
// part de `endpoints.get().base`.

const STREAMS_TTL_MS = 15 * 60 * 1000;

const endpoints = makeEndpointConfig('streamflix-endpoints.json', 'STREAMFLIX_ENDPOINTS_CONFIG', {
  base: 'https://streamflix.mom',
});
export const reloadStreamflixEndpoints = endpoints.reload;
export const getStreamflixEndpoints = endpoints.get;
const BASE = () => endpoints.get().base.replace(/\/+$/, '');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = () => ({ 'User-Agent': UA, Accept: 'application/json, */*', Referer: `${BASE()}/` });

export interface StreamFlixStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  language: string;
  headers?: Record<string, string>;
}

async function getJson<T = any>(url: string): Promise<T | null> {
  try {
    const { data, status } = await axios.get<T>(url, { headers: HEADERS(), timeout: 12000, validateStatus: () => true });
    if (status < 200 || status >= 300 || !data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

export async function getStreamFlixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  _tmdbKey?: string, // conservé pour compat de signature (plus nécessaire : API keyée TMDB)
): Promise<StreamFlixStream[]> {
  if (!tmdbId) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const key = `streamflix:${mediaType}:${tmdbId}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchStreamFlixStreams(tmdbId, mediaType, season, episode),
    { scope: 'streamflix', shouldCache: r => r.length > 0 },
  );
}

async function fetchStreamFlixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
): Promise<StreamFlixStream[]> {
  const base = BASE();
  // 1. Résoudre le contenu par tmdbId -> id interne + métadonnées.
  const kind = mediaType === 'movie' ? 'movies' : 'series';
  const meta = await getJson<any>(`${base}/api/${kind}/${encodeURIComponent(tmdbId)}`);
  if (!meta?.id) {
    console.log(`[StreamFlix] Hors catalogue (tmdb ${tmdbId})`);
    return [];
  }
  if (meta.has_video === false) {
    console.log(`[StreamFlix] Pas de vidéo pour ${meta.title || tmdbId}`);
    return [];
  }
  const title = String(meta.title || meta.original_title || meta.name || meta.original_name || '');
  const year = String(meta.release_date || meta.first_air_date || '').slice(0, 4);
  const quality = String(meta.video_quality || 'HD');

  // 2. Récupérer l'URL vidéo (id INTERNE + numéros de saison/épisode pour les séries).
  const videoUrlEndpoint = mediaType === 'movie'
    ? `${base}/api/movies/${meta.id}/video-url`
    : `${base}/api/series/${meta.id}/season/${season}/episode/${episode}/video-url`;
  const v = await getJson<any>(videoUrlEndpoint);
  const direct: string | undefined = v?.directUrl || v?.url;
  if (!direct || !/^https?:\/\//.test(direct)) {
    console.log(`[StreamFlix] Pas d'URL vidéo (tmdb ${tmdbId})`);
    return [];
  }

  let host = '';
  try { host = new URL(direct).host; } catch { /* garde vide */ }
  console.log(`[StreamFlix] ${title} -> ${host} (${quality}, ${v.isHls ? 'hls' : 'mp4'})`);

  return [{
    name: 'StreamFlix',
    title: `${title}${year ? ` (${year})` : ''}`,
    url: direct,
    quality,
    language: 'VF', // site FR, contenu doublé (chemins .../VF/...) ; has_vo non exploité ici
    // Le CDN 302 vers cheksum.lol ; certains hôtes exigent le Referer streamflix.
    headers: { Referer: `${base}/` },
  }];
}

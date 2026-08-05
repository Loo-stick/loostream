import axios from 'axios';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';

// Videasy — gros agrégateur (VO anglais + sous-titres) keyé TMDB. Protocole repris
// du VideasyExtractor d'Onyx + capture navigateur du player actuel (player.videasy.to) :
//   1. GET {base}/seed?mediaId={tmdb}                       -> { seed, ttlMs:30000 }
//   2. GET {base}/{server}/sources-with-title?title=…&enc=2&seed=…  -> réponse CHIFFRÉE
//   3. POST enc-dec.app/api/dec-videasy {text,id,seed}      -> { sources:[{quality,url}], subtitles:[{lang,url}] }
// Les m3u8 sont sur moon.ironwallnet.net (cert VALIDE, exige Referer player.videasy.to).
// Le domaine d'API TOURNE (videasy.net -> wingsdatabase -> speedracelight…) : d'où la
// base éditable dans l'admin (hot-reload) — TOUT part de `endpoints.get().base`.

const STREAMS_TTL_MS = 15 * 60 * 1000;
const DEC_URL = 'https://enc-dec.app/api/dec-videasy';
const DEFAULT_TMDB_API_KEY = process.env.TMDB_API_KEY || '';

const endpoints = makeEndpointConfig('videasy-endpoints.json', 'VIDEASY_ENDPOINTS_CONFIG', {
  base: 'https://api.speedracelight.com',
});
export const reloadVideasyEndpoints = endpoints.reload;
export const getVideasyEndpoints = endpoints.get;
const BASE = () => endpoints.get().base.replace(/\/+$/, '');

const PLAYER = 'https://player.videasy.to';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: '*/*',
  Origin: PLAYER,
  Referer: `${PLAYER}/`,
};

// Serveurs Videasy (nom affiché -> endpoint), repris d'Onyx.
const SERVERS: Array<[string, string]> = [['Hydrogen', 'cdn'], ['Titanium', 'tejo'], ['Oxygen', 'neon2']];

export interface VideasyStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  language: string;
  server: string;
  headers?: Record<string, string>;
  subtitles?: { lang: string; url: string }[];
}

async function getTmdb(tmdbId: string, mediaType: 'movie' | 'series', apiKey: string): Promise<{ title: string; year: string; imdb: string } | null> {
  const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
  return cached(
    `tmdb:vd:${endpoint}:${tmdbId}`,
    12 * 60 * 60 * 1000,
    async () => {
      try {
        const { data } = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${apiKey}&append_to_response=external_ids`, { timeout: 10000 });
        return {
          title: data?.title || data?.name || '',
          year: String(data?.release_date || data?.first_air_date || '').slice(0, 4),
          imdb: data?.external_ids?.imdb_id || data?.imdb_id || '',
        };
      } catch { return null; }
    },
    { scope: 'tmdb', shouldCache: r => !!r?.title },
  );
}

async function decrypt(encText: string, tmdbId: string, seed: string): Promise<any | null> {
  try {
    const { data } = await axios.post(DEC_URL, { text: encText, id: tmdbId, seed }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });
    return data?.result || null;
  } catch { return null; }
}

export async function getVideasyStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  tmdbKey?: string,
): Promise<VideasyStream[]> {
  if (!tmdbId) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const key = `videasy:${mediaType}:${tmdbId}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchVideasyStreams(tmdbId, mediaType, season, episode, tmdbKey),
    { scope: 'videasy', shouldCache: r => r.length > 0 },
  );
}

async function fetchVideasyStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season: number | undefined,
  episode: number | undefined,
  tmdbKey?: string,
): Promise<VideasyStream[]> {
  const apiKey = tmdbKey || DEFAULT_TMDB_API_KEY;
  if (!apiKey) return [];
  const info = await getTmdb(tmdbId, mediaType, apiKey);
  if (!info?.title) return [];

  const base = BASE();
  // 1. seed (TTL 30s -> utilisé immédiatement).
  let seed = '';
  try {
    const { data } = await axios.get(`${base}/seed?mediaId=${encodeURIComponent(tmdbId)}`, { headers: HEADERS, timeout: 12000 });
    seed = data?.seed || '';
  } catch { /* seed KO -> abandon */ }
  if (!seed) { console.log(`[Videasy] pas de seed (tmdb ${tmdbId})`); return []; }

  const title = encodeURIComponent(info.title);
  const common = `&tmdbId=${encodeURIComponent(tmdbId)}&imdbId=${encodeURIComponent(info.imdb)}&enc=2&seed=${encodeURIComponent(seed)}`;
  const q = mediaType === 'movie'
    ? `title=${title}&mediaType=movie&year=${info.year}&episodeId=1&seasonId=1${common}`
    : `title=${title}&mediaType=tv&year=${info.year}&episodeId=${episode}&seasonId=${season}${common}`;

  const streams: VideasyStream[] = [];
  const seenUrls = new Set<string>();
  // 2+3. essayer chaque serveur, déchiffrer, collecter les sources HLS + sous-titres.
  for (const [name, ep] of SERVERS) {
    let encText: string;
    try {
      const { data } = await axios.get<string>(`${base}/${ep}/sources-with-title?${q}`, { headers: HEADERS, timeout: 12000, responseType: 'text', transformResponse: r => r });
      encText = String(data || '');
    } catch { continue; }
    if (!encText || encText.trim().startsWith('{')) continue; // vide ou erreur JSON en clair
    const result = await decrypt(encText, tmdbId, seed);
    const sources: any[] = result?.sources || [];
    if (!sources.length) continue;
    const subtitles = (result?.subtitles || [])
      .filter((s: any) => s?.url && /^https?:\/\//.test(s.url))
      .map((s: any) => ({ lang: String(s.lang || s.language || 'und'), url: String(s.url) }));
    for (const s of sources) {
      const url = String(s?.url || '');
      if (!url || !url.includes('.m3u8') || seenUrls.has(url)) continue;
      seenUrls.add(url);
      streams.push({
        name: `Videasy ${name}`,
        title: `${info.title}${info.year ? ` (${info.year})` : ''}`,
        url,
        quality: String(s.quality || 'HD'),
        language: 'VO', // audio original (anglais) ; sous-titres attachés -> VOSTFR quand FR dispo
        server: name,
        headers: { Referer: `${PLAYER}/`, Origin: PLAYER },
        subtitles,
      });
    }
  }
  if (streams.length) console.log(`[Videasy] tmdb ${tmdbId} -> ${streams.length} flux (${streams[0].quality}, ${streams[0].subtitles?.length || 0} sub)`);
  return streams;
}

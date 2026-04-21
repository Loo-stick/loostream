import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';

const STREAMS_TTL_MS = 15 * 60 * 1000;

interface MovixEndpoints {
  api: string;
  referer: string;
  origin: string;
}

const DEFAULT_ENDPOINTS: MovixEndpoints = {
  api: 'https://api.movix.cash',
  referer: 'https://movix.cash/',
  origin: 'https://movix.cash',
};

const ENDPOINTS_PATH = process.env.MOVIX_ENDPOINTS_CONFIG ||
  (fs.existsSync('/app/config/movix-endpoints.json')
    ? '/app/config/movix-endpoints.json'
    : path.join(process.cwd(), 'config', 'movix-endpoints.json'));

let endpoints: MovixEndpoints = { ...DEFAULT_ENDPOINTS };

function loadEndpoints(): void {
  try {
    if (fs.existsSync(ENDPOINTS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(ENDPOINTS_PATH, 'utf-8'));
      if (raw.api && raw.referer && raw.origin) {
        endpoints = { api: raw.api, referer: raw.referer, origin: raw.origin };
        console.log(`[Movix] Endpoints loaded: api=${endpoints.api}`);
        return;
      }
    }
  } catch (e: any) {
    console.error(`[Movix] Error loading endpoints: ${e.message}`);
  }
  endpoints = { ...DEFAULT_ENDPOINTS };
  console.log(`[Movix] Using default endpoints: api=${endpoints.api}`);
}

export function reloadMovixEndpoints(): MovixEndpoints {
  loadEndpoints();
  return { ...endpoints };
}

export function getMovixEndpoints(): MovixEndpoints {
  return { ...endpoints };
}

loadEndpoints();

try {
  if (fs.existsSync(ENDPOINTS_PATH)) {
    fs.watch(ENDPOINTS_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[Movix] Endpoints file changed, reloading...');
        setTimeout(loadEndpoints, 100);
      }
    });
  }
} catch {
  // watch not supported
}

function buildHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': endpoints.referer,
    'Origin': endpoints.origin,
  };
}

export interface MovixStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  language: string;
  format: string;
  headers?: Record<string, string>;
  server?: string;
}

function extractQuality(name: string): string {
  if (name.includes('1080')) return '1080p';
  if (name.includes('720')) return '720p';
  if (name.includes('480')) return '480p';
  if (name.includes('4K') || name.includes('2160')) return '4K';
  return 'HD';
}

function extractLanguage(name: string): string {
  const nameLower = name.toLowerCase();
  if (nameLower.includes('vostfr')) return 'VOSTFR';
  if (nameLower.includes('vf')) return 'VF';
  if (nameLower.includes('multi')) return 'MULTI';
  if (nameLower.includes('french')) return 'VF';
  return 'VO';
}

// API 1: Purstream - direct m3u8
async function fetchPurstream(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<MovixStream[]> {
  const url = mediaType === 'series'
    ? `${endpoints.api}/api/purstream/tv/${tmdbId}/stream?season=${season || 1}&episode=${episode || 1}`
    : `${endpoints.api}/api/purstream/movie/${tmdbId}/stream`;

  console.log(`[Movix] Purstream: ${url}`);

  try {
    const { data } = await axios.get(url, { headers: buildHeaders(), timeout: 10000 });

    if (!data || !data.sources || !Array.isArray(data.sources)) {
      return [];
    }

    return data.sources.map((source: any) => ({
      name: 'Movix',
      title: source.name || 'Movix VF',
      url: source.url,
      quality: extractQuality(source.name || ''),
      language: extractLanguage(source.name || ''),
      format: source.format || 'm3u8',
      server: (source.name || '').split('|')[0].trim().toLowerCase() || 'purstream',
    }));
  } catch (e) {
    console.log('[Movix] Purstream failed:', e);
    return [];
  }
}

interface CpasmalLink {
  server: string;
  url: string;
  language: string;
}

// API 2: Cpasmal - VF/VOSTFR sources (returns raw embed URLs)
async function fetchCpasmal(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<CpasmalLink[]> {
  const url = mediaType === 'series'
    ? `${endpoints.api}/api/cpasmal/tv/${tmdbId}/${season || 1}/${episode || 1}`
    : `${endpoints.api}/api/cpasmal/movie/${tmdbId}`;

  console.log(`[Movix] Cpasmal: ${url}`);

  try {
    const { data } = await axios.get(url, { headers: buildHeaders(), timeout: 10000 });

    if (!data || !data.links) {
      return [];
    }

    const links: CpasmalLink[] = [];
    const langs = ['vf', 'vostfr'];

    for (const lang of langs) {
      if (data.links[lang] && Array.isArray(data.links[lang])) {
        for (const link of data.links[lang]) {
          if (link.url) {
            links.push({
              server: link.server || 'unknown',
              url: link.url,
              language: lang.toUpperCase(),
            });
          }
        }
      }
    }

    return links;
  } catch (e) {
    console.log('[Movix] Cpasmal failed:', e);
    return [];
  }
}

// API 3: FStream — VFQ/VFF/VOSTFR embeds
async function fetchFStream(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<CpasmalLink[]> {
  const url = mediaType === 'series'
    ? `${endpoints.api}/api/fstream/tv/${tmdbId}/${season || 1}/${episode || 1}`
    : `${endpoints.api}/api/fstream/movie/${tmdbId}`;

  console.log(`[Movix] FStream: ${url}`);

  try {
    const { data } = await axios.get(url, { headers: buildHeaders(), timeout: 10000 });
    if (!data?.players) return [];

    const bucketToLang: Record<string, string> = { VFQ: 'VF', VFF: 'VF', VOSTFR: 'VOSTFR' };
    const links: CpasmalLink[] = [];

    for (const [bucket, lang] of Object.entries(bucketToLang)) {
      const items = data.players[bucket];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item?.url) {
          links.push({
            server: (item.player || 'unknown').toLowerCase(),
            url: item.url,
            language: lang,
          });
        }
      }
    }
    return links;
  } catch (e) {
    console.log('[Movix] FStream failed:', e);
    return [];
  }
}

export async function getMovixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  extractorConfig?: ExtractorConfig
): Promise<MovixStream[]> {
  const key = `movix:${mediaType}:${tmdbId}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchMovixStreams(tmdbId, mediaType, season, episode, extractorConfig),
    { scope: 'movix', shouldCache: r => r.length > 0 }
  );
}

async function fetchMovixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  extractorConfig?: ExtractorConfig
): Promise<MovixStream[]> {
  console.log(`[Movix] Searching for TMDB ${tmdbId}...`);

  // Fetch all 3 sources in parallel
  const [purstreamResults, cpasmalLinks, fstreamLinks] = await Promise.all([
    fetchPurstream(tmdbId, mediaType, season, episode),
    fetchCpasmal(tmdbId, mediaType, season, episode),
    fetchFStream(tmdbId, mediaType, season, episode),
  ]);

  console.log(`[Movix] Purstream=${purstreamResults.length}, Cpasmal=${cpasmalLinks.length}, FStream=${fstreamLinks.length}`);

  const streams: MovixStream[] = [...purstreamResults];

  // Merge embed links, keep only those our extractor supports (Voe/Uqload)
  const allEmbeds = [...cpasmalLinks, ...fstreamLinks].filter(link => {
    try { return detectExtractor(link.url) !== null; } catch { return false; }
  });

  if (allEmbeds.length === 0) {
    console.log(`[Movix] No supported embeds to extract`);
    return streams;
  }

  console.log(`[Movix] ${allEmbeds.length} supported embed(s) to extract`);

  const processedServers = new Set<string>();

  for (const link of allEmbeds.slice(0, 8)) {
    // Skip if we already have a stream from this server+language combo
    const key = `${link.server}-${link.language}`;
    if (processedServers.has(key)) continue;

    try {
      const extracted = await extractStream(link.url, extractorConfig);

      if (extracted) {
        processedServers.add(key);
        streams.push({
          name: 'Movix',
          title: `${link.language} - ${link.server}`,
          url: extracted.url,
          quality: extracted.quality,
          language: link.language,
          format: extracted.format === 'hls' ? 'm3u8' : 'mp4',
          headers: extracted.headers,
          server: link.server,
        });
        console.log(`[Movix] Extracted ${link.server} (${link.language}): ${extracted.format}`);
      }
    } catch (e: any) {
      console.log(`[Movix] Failed to extract ${link.server}:`, e.message);
    }
  }

  console.log(`[Movix] Total: ${streams.length} stream(s) extracted`);
  return streams;
}

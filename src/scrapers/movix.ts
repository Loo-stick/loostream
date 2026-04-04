import axios from 'axios';
import { extractStream, ExtractorConfig } from '../extractors';

const MOVIX_API = 'https://api.movix.blog';
const MOVIX_REFERER = 'https://movix.rodeo/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': MOVIX_REFERER,
  'Origin': 'https://movix.rodeo',
};

export interface MovixStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  language: string;
  format: string;
  headers?: Record<string, string>;
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
    ? `${MOVIX_API}/api/purstream/tv/${tmdbId}/stream?season=${season || 1}&episode=${episode || 1}`
    : `${MOVIX_API}/api/purstream/movie/${tmdbId}/stream`;

  console.log(`[Movix] Purstream: ${url}`);

  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });

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
    ? `${MOVIX_API}/api/cpasmal/tv/${tmdbId}/${season || 1}/${episode || 1}`
    : `${MOVIX_API}/api/cpasmal/movie/${tmdbId}`;

  console.log(`[Movix] Cpasmal: ${url}`);

  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });

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

export async function getMovixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  extractorConfig?: ExtractorConfig
): Promise<MovixStream[]> {
  console.log(`[Movix] Searching for TMDB ${tmdbId}...`);

  // Try Purstream first (direct m3u8)
  const purstreamResults = await fetchPurstream(tmdbId, mediaType, season, episode);

  if (purstreamResults.length > 0) {
    console.log(`[Movix] Purstream returned ${purstreamResults.length} stream(s)`);
    return purstreamResults;
  }

  // Fallback to Cpasmal (embed URLs that need extraction)
  const cpasmalLinks = await fetchCpasmal(tmdbId, mediaType, season, episode);

  if (cpasmalLinks.length === 0) {
    console.log(`[Movix] No Cpasmal links found`);
    return [];
  }

  console.log(`[Movix] Cpasmal returned ${cpasmalLinks.length} embed link(s)`);

  // Extract video URLs from embeds (limit to 3 to avoid too many requests)
  const streams: MovixStream[] = [];
  const processedServers = new Set<string>();

  for (const link of cpasmalLinks.slice(0, 6)) {
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

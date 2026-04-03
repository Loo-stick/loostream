import axios from 'axios';

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

// API 2: Cpasmal - VF/VOSTFR sources
async function fetchCpasmal(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<MovixStream[]> {
  const url = mediaType === 'series'
    ? `${MOVIX_API}/api/cpasmal/tv/${tmdbId}/${season || 1}/${episode || 1}`
    : `${MOVIX_API}/api/cpasmal/movie/${tmdbId}`;

  console.log(`[Movix] Cpasmal: ${url}`);

  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });

    if (!data || !data.links) {
      return [];
    }

    const streams: MovixStream[] = [];
    const langs = ['vf', 'vostfr'];

    for (const lang of langs) {
      if (data.links[lang] && Array.isArray(data.links[lang])) {
        for (const link of data.links[lang]) {
          // Skip unsupported players that require JS/cookies
          const unsupported = ['netu', 'voe', 'uqload', 'doodstream', 'vidoza'];
          if (unsupported.some(p => link.url?.toLowerCase().includes(p))) {
            continue;
          }

          streams.push({
            name: 'Movix',
            title: `${lang.toUpperCase()} - ${link.server}`,
            url: link.url,
            quality: 'HD',
            language: lang.toUpperCase(),
            format: 'embed',
          });
        }
      }
    }

    return streams;
  } catch (e) {
    console.log('[Movix] Cpasmal failed:', e);
    return [];
  }
}

export async function getMovixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<MovixStream[]> {
  console.log(`[Movix] Searching for TMDB ${tmdbId}...`);

  // Try Purstream first (direct m3u8)
  let streams = await fetchPurstream(tmdbId, mediaType, season, episode);

  if (streams.length > 0) {
    console.log(`[Movix] Purstream returned ${streams.length} stream(s)`);
    return streams;
  }

  // Fallback to Cpasmal
  streams = await fetchCpasmal(tmdbId, mediaType, season, episode);

  if (streams.length > 0) {
    console.log(`[Movix] Cpasmal returned ${streams.length} stream(s)`);
    // Filter to only direct streams (m3u8/mp4)
    streams = streams.filter(s =>
      s.url.includes('.m3u8') || s.url.includes('.mp4')
    );
  }

  console.log(`[Movix] Total: ${streams.length} stream(s)`);
  return streams;
}

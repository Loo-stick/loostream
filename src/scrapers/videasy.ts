import axios from 'axios';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Connection': 'keep-alive'
};

const API = 'https://enc-dec.app/api';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

interface ServerConfig {
  url: string;
  language: string;
  params?: Record<string, string>;
  moviesOnly?: boolean;
}

// French + Original language servers
const SERVERS: Record<string, ServerConfig> = {
  // French server (priority)
  'Chamber': {
    url: 'https://api.videasy.net/meine/sources-with-title',
    language: 'French',
    params: { language: 'french' },
    moviesOnly: true
  },
  // Original/VO servers
  'Neon': {
    url: 'https://api.videasy.net/myflixerzupcloud/sources-with-title',
    language: 'Original'
  },
  'Sage': {
    url: 'https://api.videasy.net/1movies/sources-with-title',
    language: 'Original'
  },
  'Cypher': {
    url: 'https://api.videasy.net/moviebox/sources-with-title',
    language: 'Original'
  },
  'Reyna': {
    url: 'https://api2.videasy.net/primewire/sources-with-title',
    language: 'Original'
  },
  'Omen': {
    url: 'https://api.videasy.net/onionplay/sources-with-title',
    language: 'Original'
  },
  'Breach': {
    url: 'https://api.videasy.net/m4uhd/sources-with-title',
    language: 'Original'
  },
  'Vyse': {
    url: 'https://api.videasy.net/hdmovie/sources-with-title',
    language: 'Original'
  },
};

export interface VideoEasyStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  server: string;
  language: string;
}

interface MediaDetails {
  id: number;
  title: string;
  year: string;
  imdbId: string;
  mediaType: 'movie' | 'tv';
}

interface VideoEasySource {
  url?: string;
  quality?: string;
  language?: string;
}

interface VideoEasyData {
  sources?: VideoEasySource[];
}

async function fetchMediaDetails(tmdbId: string, mediaType: 'movie' | 'series'): Promise<MediaDetails | null> {
  try {
    const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });

    return {
      id: data.id,
      title: data.title || data.name,
      year: (data.release_date || data.first_air_date || '').split('-')[0],
      imdbId: data.external_ids?.imdb_id || '',
      mediaType: mediaType === 'movie' ? 'movie' : 'tv',
    };
  } catch (e) {
    console.log('[VidEasy] Error fetching TMDB details:', e);
    return null;
  }
}

async function decryptVideoEasy(encryptedText: string, tmdbId: string): Promise<VideoEasyData | null> {
  try {
    const { data } = await axios.post(`${API}/dec-videasy`, {
      text: encryptedText,
      id: tmdbId
    }, {
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return data.result;
  } catch (e) {
    console.log('[VidEasy] Decryption error:', e);
    return null;
  }
}

function buildVideoEasyUrl(
  serverConfig: ServerConfig,
  mediaType: 'movie' | 'tv',
  title: string,
  year: string,
  tmdbId: string,
  imdbId: string,
  season?: number,
  episode?: number
): string {
  const params: Record<string, string> = {
    title,
    mediaType,
    year,
    tmdbId,
    imdbId,
  };

  if (serverConfig.params) {
    Object.assign(params, serverConfig.params);
  }

  if (mediaType === 'tv' && season && episode) {
    params.seasonId = String(season);
    params.episodeId = String(episode);
  }

  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  return `${serverConfig.url}?${queryString}`;
}

function extractQualityFromUrl(url: string): string {
  if (url.includes('1080') || url.includes('1920')) return '1080p';
  if (url.includes('720') || url.includes('1280')) return '720p';
  if (url.includes('480') || url.includes('854')) return '480p';
  if (url.includes('360') || url.includes('640')) return '360p';

  const match = url.match(/(\d{3,4})p/i);
  if (match) return `${match[1]}p`;

  return 'Auto';
}

async function fetchFromServer(
  serverName: string,
  serverConfig: ServerConfig,
  mediaDetails: MediaDetails,
  season?: number,
  episode?: number
): Promise<VideoEasyStream[]> {
  // Skip movie-only servers for TV shows
  if (mediaDetails.mediaType === 'tv' && serverConfig.moviesOnly) {
    return [];
  }

  try {
    const url = buildVideoEasyUrl(
      serverConfig,
      mediaDetails.mediaType,
      mediaDetails.title,
      mediaDetails.year,
      String(mediaDetails.id),
      mediaDetails.imdbId,
      season,
      episode
    );

    const { data: encryptedData } = await axios.get(url, {
      headers: HEADERS,
      timeout: 15000,
    });

    if (!encryptedData || typeof encryptedData !== 'string') {
      return [];
    }

    const decrypted = await decryptVideoEasy(encryptedData, String(mediaDetails.id));
    if (!decrypted?.sources) {
      return [];
    }

    const streams: VideoEasyStream[] = [];

    for (const source of decrypted.sources) {
      if (!source.url) continue;

      // Only keep HLS streams for compatibility with MediaFlow
      if (!source.url.includes('.m3u8')) continue;

      const quality = source.quality || extractQualityFromUrl(source.url);

      streams.push({
        name: `VidEasy ${serverName}`,
        title: `${mediaDetails.title} (${mediaDetails.year})`,
        url: source.url,
        quality,
        server: serverName,
        language: serverConfig.language,
      });
    }

    if (streams.length > 0) {
      console.log(`[VidEasy] ${serverName}: ${streams.length} stream(s)`);
    }

    return streams;
  } catch (e) {
    return [];
  }
}

export async function getVideoEasyStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<VideoEasyStream[]> {
  console.log(`[VidEasy] Searching for TMDB ${tmdbId}...`);

  const mediaDetails = await fetchMediaDetails(tmdbId, mediaType);
  if (!mediaDetails) {
    console.log('[VidEasy] Could not fetch media details');
    return [];
  }

  console.log(`[VidEasy] Found: ${mediaDetails.title} (${mediaDetails.year})`);

  // Fetch from all servers in parallel
  const serverEntries = Object.entries(SERVERS);
  const results = await Promise.all(
    serverEntries.map(([name, config]) =>
      fetchFromServer(name, config, mediaDetails, season, episode)
    )
  );

  // Combine and deduplicate
  const allStreams: VideoEasyStream[] = [];
  const seenUrls = new Set<string>();

  for (const streams of results) {
    for (const stream of streams) {
      if (!seenUrls.has(stream.url)) {
        seenUrls.add(stream.url);
        allStreams.push(stream);
      }
    }
  }

  // Sort by quality
  const qualityOrder: Record<string, number> = {
    '4K': 2160, '2160p': 2160, '1440p': 1440, '1080p': 1080,
    '720p': 720, '480p': 480, '360p': 360, '240p': 240, 'Auto': 500
  };

  allStreams.sort((a, b) => {
    const qa = qualityOrder[a.quality] || 0;
    const qb = qualityOrder[b.quality] || 0;
    return qb - qa;
  });

  console.log(`[VidEasy] Total: ${allStreams.length} stream(s)`);
  return allStreams;
}

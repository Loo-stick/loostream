import axios from 'axios';

const SF_BASE = 'https://api.streamflix.app';
const CONFIG_URL = `${SF_BASE}/config/config-streamflixapp.json`;
const DATA_URL = `${SF_BASE}/data.json`;
const DEFAULT_TMDB_API_KEY = process.env.TMDB_API_KEY || '';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, */*',
  'Referer': 'https://api.streamflix.app/',
};

// Cache
let configCache: any = null;
let configCacheTime = 0;
let dataCache: any[] = [];
let dataCacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export interface StreamFlixStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  language: string;
}

async function getConfig(): Promise<any> {
  if (configCache && Date.now() - configCacheTime < CACHE_TTL) {
    return configCache;
  }

  try {
    const { data } = await axios.get(CONFIG_URL, { headers: HEADERS, timeout: 15000 });
    configCache = data;
    configCacheTime = Date.now();
    console.log('[StreamFlix] Config loaded');
    return data;
  } catch (e) {
    console.log('[StreamFlix] Error loading config:', e);
    return null;
  }
}

async function getData(): Promise<any[]> {
  if (dataCache.length && Date.now() - dataCacheTime < CACHE_TTL) {
    return dataCache;
  }

  try {
    const { data } = await axios.get(DATA_URL, { headers: HEADERS, timeout: 30000 });

    // Extract items array
    let items: any[] = [];
    if (Array.isArray(data)) {
      items = data;
    } else if (data.data && Array.isArray(data.data)) {
      items = data.data;
    } else if (data.movies && Array.isArray(data.movies)) {
      items = data.movies;
    } else {
      // Try to find any array in the response
      for (const val of Object.values(data)) {
        if (Array.isArray(val) && val.length > 5) {
          items = val as any[];
          break;
        }
      }
    }

    dataCache = items;
    dataCacheTime = Date.now();
    console.log(`[StreamFlix] Data loaded: ${items.length} items`);
    return items;
  } catch (e) {
    console.log('[StreamFlix] Error loading data:', e);
    return [];
  }
}

function getTitle(item: any): string {
  const fields = ['moviename', 'Movie_Name', 'movie_name', 'MovieName', 'title', 'Title', 'name', 'Name'];
  for (const f of fields) {
    if (item[f]) return String(item[f]);
  }
  return '';
}

function getLink(item: any): string {
  const fields = ['movielink', 'Movie_Link', 'movie_link', 'MovieLink', 'link', 'Link', 'url', 'file', 'stream'];
  for (const f of fields) {
    if (item[f]) return String(item[f]);
  }
  return '';
}

function getKey(item: any): string {
  const fields = ['moviekey', 'Movie_Key', 'movie_key', 'MovieKey', 'key', 'Key', 'firebase_key', 'id', 'ID'];
  for (const f of fields) {
    if (item[f]) return String(item[f]);
  }
  return '';
}

function getLanguage(item: any): string {
  const fields = ['movielanguage', 'language', 'Language', 'lang', 'audio'];
  for (const f of fields) {
    if (item[f]) return String(item[f]);
  }
  return 'Original';
}

function getQuality(item: any): string {
  // Try to get quality from item data
  const qualityFields = ['moviequality', 'quality', 'Quality', 'resolution', 'Resolution'];
  for (const f of qualityFields) {
    if (item[f]) return String(item[f]);
  }

  // Try to extract from link
  const link = getLink(item);
  if (link) {
    if (link.includes('4k') || link.includes('2160')) return '4K';
    if (link.includes('1080')) return '1080p';
    if (link.includes('720')) return '720p';
    if (link.includes('480')) return '480p';
  }

  // Try to extract from title
  const title = getTitle(item);
  if (title) {
    const qualityMatch = title.match(/(\d{3,4}p|4K|HD|FHD)/i);
    if (qualityMatch) return qualityMatch[1].toUpperCase();
  }

  return 'HD';
}

function normalizeTitle(title: string): string {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function calculateSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 1));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 1));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;

  return intersection / union; // Jaccard similarity
}

function getCdnUrls(config: any): string[] {
  if (!config) return [];

  // StreamFlix uses "movies" and "tv" arrays for CDN URLs
  const cdns: string[] = [];

  if (config.movies && Array.isArray(config.movies)) {
    cdns.push(...config.movies.filter((u: string) => u && u.startsWith('http')));
  }
  if (config.tv && Array.isArray(config.tv)) {
    cdns.push(...config.tv.filter((u: string) => u && u.startsWith('http')));
  }
  if (config.premium && Array.isArray(config.premium)) {
    cdns.push(...config.premium.filter((u: string) => u && u.startsWith('http')));
  }

  // Deduplicate
  return [...new Set(cdns)];
}

async function checkUrl(url: string): Promise<boolean> {
  try {
    const resp = await axios.head(url, {
      headers: HEADERS,
      timeout: 5000,
      validateStatus: (status) => status < 400
    });
    return true;
  } catch {
    return false;
  }
}

export async function getStreamFlixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  tmdbKey?: string
): Promise<StreamFlixStream[]> {
  const apiKey = tmdbKey || DEFAULT_TMDB_API_KEY;

  if (!apiKey) {
    console.log('[StreamFlix] No TMDB API key available, skipping');
    return [];
  }

  console.log(`[StreamFlix] Searching for TMDB ${tmdbId}...`);

  try {
    // Get TMDB info
    const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
    const { data: tmdbData } = await axios.get(
      `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${apiKey}`,
      { timeout: 10000 }
    );

    const title = tmdbData.title || tmdbData.name;
    const year = (tmdbData.release_date || tmdbData.first_air_date || '').split('-')[0];

    if (!title) {
      console.log('[StreamFlix] No TMDB title found');
      return [];
    }

    console.log(`[StreamFlix] Found: ${title} (${year})`);

    // Load config and data in parallel
    const [config, items] = await Promise.all([getConfig(), getData()]);

    if (!config || !items.length) {
      console.log('[StreamFlix] No config or data');
      return [];
    }

    // Search for matching content with similarity threshold
    const normalizedTitle = normalizeTitle(title);
    const matches = items
      .map(item => {
        const itemTitle = normalizeTitle(getTitle(item));
        const similarity = calculateSimilarity(normalizedTitle, itemTitle);
        return { item, itemTitle, similarity };
      })
      .filter(({ similarity }) => similarity >= 0.6) // 60% similarity threshold
      .sort((a, b) => b.similarity - a.similarity); // Best matches first

    if (!matches.length) {
      console.log('[StreamFlix] No matches found');
      return [];
    }

    console.log(`[StreamFlix] Found ${matches.length} match(es): ${matches.map(m => `${m.itemTitle} (${(m.similarity * 100).toFixed(0)}%)`).join(', ')}`);

    // Get CDN base URLs
    const cdnUrls = getCdnUrls(config);
    console.log(`[StreamFlix] CDN URLs: ${cdnUrls.length}`);

    const streams: StreamFlixStream[] = [];

    for (const { item } of matches.slice(0, 3)) { // Limit to 3 matches
      const link = getLink(item);
      const language = getLanguage(item);
      const quality = getQuality(item);

      console.log(`[StreamFlix] Item data:`, JSON.stringify(item).substring(0, 500));
      console.log(`[StreamFlix] Extracted - link: ${link}, quality: ${quality}, language: ${language}`);

      if (!link) continue;

      // If link is already a full URL, use it directly
      if (link.startsWith('http')) {
        streams.push({
          name: 'StreamFlix',
          title: `${title} (${year})`,
          url: link,
          quality,
          language,
        });
      } else if (cdnUrls.length > 0) {
        // Create streams for multiple CDNs (as fallbacks)
        for (const cdnBase of cdnUrls.slice(0, 2)) { // Limit to 2 CDNs
          const fullUrl = `${cdnBase}${link}`;
          streams.push({
            name: 'StreamFlix',
            title: `${title} (${year})`,
            url: fullUrl,
            quality,
            language,
          });
        }
      }
    }

    console.log(`[StreamFlix] Total: ${streams.length} stream(s)`);
    return streams;

  } catch (e) {
    console.log('[StreamFlix] Error:', e);
    return [];
  }
}

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';

interface FlemmixEndpoints {
  base: string;    // e.g. https://flemmix.wales
  origin: string;
  referer: string;
}

const DEFAULT_ENDPOINTS: FlemmixEndpoints = {
  base: 'https://flemmix.wales',
  origin: 'https://flemmix.wales',
  referer: 'https://flemmix.wales/',
};

const ENDPOINTS_PATH = process.env.FLEMMIX_ENDPOINTS_CONFIG ||
  (fs.existsSync('/app/config/flemmix-endpoints.json')
    ? '/app/config/flemmix-endpoints.json'
    : path.join(process.cwd(), 'config', 'flemmix-endpoints.json'));

let endpoints: FlemmixEndpoints = { ...DEFAULT_ENDPOINTS };

function loadEndpoints(): void {
  try {
    if (fs.existsSync(ENDPOINTS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(ENDPOINTS_PATH, 'utf-8'));
      if (raw.base) {
        endpoints = {
          base: raw.base.replace(/\/+$/, ''),
          origin: raw.origin || raw.base.replace(/\/+$/, ''),
          referer: raw.referer || raw.base.replace(/\/+$/, '') + '/',
        };
        console.log(`[Flemmix] Endpoints loaded: base=${endpoints.base}`);
        return;
      }
    }
  } catch (e: any) {
    console.error(`[Flemmix] Error loading endpoints: ${e.message}`);
  }
  endpoints = { ...DEFAULT_ENDPOINTS };
  console.log(`[Flemmix] Using default endpoints: base=${endpoints.base}`);
}

export function reloadFlemmixEndpoints(): FlemmixEndpoints {
  loadEndpoints();
  return { ...endpoints };
}

export function getFlemmixEndpoints(): FlemmixEndpoints {
  return { ...endpoints };
}

loadEndpoints();

try {
  if (fs.existsSync(ENDPOINTS_PATH)) {
    fs.watch(ENDPOINTS_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[Flemmix] Endpoints file changed, reloading...');
        setTimeout(loadEndpoints, 100);
      }
    });
  }
} catch {
  // watch not supported
}

const STREAMS_TTL_MS = 15 * 60 * 1000;
const TMDB_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TMDB_API_KEY = process.env.TMDB_API_KEY || '';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

export interface FlemmixStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  language: string;
  server: string;
  headers?: Record<string, string>;
}

interface SearchResult {
  url: string;
  title: string;
  origTitle: string | null;
  language: string;
}

// DataLife search returns an HTML list of film cards
function parseSearchHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Each card has a div.item > a href with title1 + optional title0 spans
  const itemRegex = /<div class="item">\s*<a href="([^"]+)">[\s\S]*?<span class="title1">([^<]+)<\/span>(?:[\s\S]{0,200}?<span class="title0">([^<]*)<\/span>)?/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(html)) !== null) {
    const url = m[1].trim();
    if (!/\/film-en-streaming\/\d+-/.test(url) && !/\/serie-en-streaming\/\d+-/.test(url)) continue;
    results.push({
      url,
      title: decodeEntities(m[2].trim()),
      origTitle: m[3] ? decodeEntities(m[3].trim()) : null,
      language: 'VF',
    });
  }
  return results;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function normalize(s: string): string {
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccard(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter(w => w.length > 1));
  const wb = new Set(b.split(' ').filter(w => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  const inter = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return inter / union;
}

async function searchFilms(query: string): Promise<SearchResult[]> {
  try {
    const body = new URLSearchParams({
      do: 'search',
      subaction: 'search',
      story: query,
    }).toString();

    const { data: html } = await axios.post(`${endpoints.base}/index.php?do=search`, body, {
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': endpoints.origin,
        'Referer': endpoints.referer,
      },
      timeout: 15000,
    });
    return parseSearchHtml(html);
  } catch (e: any) {
    console.log('[Flemmix] Search failed:', e.message);
    return [];
  }
}

interface EmbedLink {
  server: string;
  url: string;
}

async function fetchFilmEmbeds(filmUrl: string): Promise<EmbedLink[]> {
  try {
    const { data: html } = await axios.get(filmUrl, {
      headers: { ...HEADERS, Referer: endpoints.referer },
      timeout: 15000,
    });
    const embeds: EmbedLink[] = [];
    // loadVideo('URL', this) ... <span>SERVER</span>
    const regex = /loadVideo\(\s*['"]([^'"]+)['"]\s*,\s*this\s*\)[\s\S]{0,150}?<span>([^<]+)<\/span>/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
      embeds.push({
        server: m[2].trim(),
        url: m[1].trim(),
      });
    }
    return embeds;
  } catch (e: any) {
    console.log(`[Flemmix] Film page fetch failed: ${e.message}`);
    return [];
  }
}

export async function getFlemmixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  tmdbKey?: string,
  season?: number,
  episode?: number
): Promise<FlemmixStream[]> {
  if (mediaType !== 'movie') return []; // MVP: films only

  const apiKey = tmdbKey || DEFAULT_TMDB_API_KEY;
  if (!apiKey) {
    console.log('[Flemmix] No TMDB API key, skipping');
    return [];
  }

  const key = `flemmix:${mediaType}:${tmdbId}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchFlemmixStreams(tmdbId, apiKey, extractorConfig),
    { scope: 'flemmix', shouldCache: r => r.length > 0 }
  );
}

async function fetchFlemmixStreams(
  tmdbId: string,
  apiKey: string,
  extractorConfig: ExtractorConfig
): Promise<FlemmixStream[]> {
  console.log(`[Flemmix] Searching for TMDB ${tmdbId}...`);

  try {
    // Reuse the fr-FR TMDB cache already populated by Faklum
    const tmdbData = await cached<any>(
      `tmdb:movie-fr:${tmdbId}`,
      TMDB_TTL_MS,
      async () => {
        const { data } = await axios.get(
          `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=fr-FR`,
          { timeout: 10000 }
        );
        return data;
      },
      { scope: 'tmdb', shouldCache: r => !!r }
    );

    const frTitle: string = tmdbData?.title || tmdbData?.original_title;
    const origTitle: string = tmdbData?.original_title || '';
    const year = tmdbData?.release_date ? parseInt(tmdbData.release_date.split('-')[0], 10) : null;
    if (!frTitle) return [];

    console.log(`[Flemmix] TMDB: ${frTitle} (${year}) / orig: ${origTitle}`);

    const searchResults = await searchFilms(frTitle);
    if (searchResults.length === 0) {
      console.log('[Flemmix] No search results');
      return [];
    }

    // Fuzzy match on FR or original title
    const normFr = normalize(frTitle);
    const normOrig = origTitle ? normalize(origTitle) : '';
    const ranked = searchResults
      .map(r => {
        const simFr = jaccard(normFr, normalize(r.title));
        const simOrig = r.origTitle ? jaccard(normOrig || normFr, normalize(r.origTitle)) : 0;
        const sim = Math.max(simFr, simOrig);
        return { r, sim };
      })
      .filter(({ sim }) => sim >= 0.7)
      .sort((a, b) => b.sim - a.sim);

    if (ranked.length === 0) {
      console.log('[Flemmix] No fuzzy match above threshold');
      return [];
    }

    console.log(`[Flemmix] ${ranked.length} match(es), best: ${ranked[0].r.title} (${(ranked[0].sim * 100).toFixed(0)}%)`);

    const best = ranked[0].r;
    const embeds = await fetchFilmEmbeds(best.url);
    if (embeds.length === 0) {
      console.log('[Flemmix] No embeds on film page');
      return [];
    }

    // Filter only embeds we can resolve (MFP or local)
    const supported = embeds.filter(e => {
      try { return detectExtractor(e.url) !== null; } catch { return false; }
    });
    console.log(`[Flemmix] ${embeds.length} embeds, ${supported.length} supported: ${supported.map(e => e.server).join(', ')}`);

    const streams: FlemmixStream[] = [];
    const seen = new Set<string>();

    for (const embed of supported.slice(0, 6)) {
      if (seen.has(embed.server)) continue;
      seen.add(embed.server);

      const extracted = await extractStream(embed.url, extractorConfig);
      if (!extracted) {
        console.log(`[Flemmix] Extraction failed for ${embed.server} (${embed.url})`);
        continue;
      }

      streams.push({
        name: 'Flemmix',
        title: best.title,
        url: extracted.url,
        quality: extracted.quality || 'HD',
        language: best.language,
        server: embed.server.toLowerCase(),
        headers: extracted.headers,
      });
      console.log(`[Flemmix] Extracted ${embed.server}: ${extracted.format}`);
    }

    console.log(`[Flemmix] Returning ${streams.length} stream(s)`);
    return streams;
  } catch (e: any) {
    console.log('[Flemmix] Error:', e.message);
    return [];
  }
}

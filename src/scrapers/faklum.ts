import axios from 'axios';
import { extractStream, ExtractorConfig } from '../extractors';
import { cached } from '../cache';

const STREAMS_TTL_MS = 15 * 60 * 1000;

const FAKLUM_BASE = 'https://faklum.com';
const DEFAULT_TMDB_API_KEY = process.env.TMDB_API_KEY || '';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/json,*/*',
};

const INDEX_TTL = 30 * 60 * 1000; // 30 min
const TOKEN_TTL = 6 * 60 * 60 * 1000; // 6 h
const PAGE_SIZE = 20;
const MAX_OFFSET = 6000;
const PARALLEL_PAGES = 5;

interface FaklumFilm {
  id: string;          // faklum internal id (e.g. "17368")
  title: string;       // "Blanche Neige (2025)"
  year: number | null; // 2025
  cleanTitle: string;  // normalized without year
  hd: boolean;
  vostfr: boolean;
  linkId: string;      // numeric id used in /b/faklum/<linkId>
}

export interface FaklumStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  language: string;
  headers?: Record<string, string>;
}

// --- session token ---

let sessionToken: string | null = null;
let sessionTokenAt = 0;

async function getSessionToken(force = false): Promise<string | null> {
  if (!force && sessionToken && Date.now() - sessionTokenAt < TOKEN_TTL) {
    return sessionToken;
  }
  try {
    const { data: html } = await axios.get(`${FAKLUM_BASE}/`, { headers: HEADERS, timeout: 15000 });
    const match = html.match(/<a\s+id=["']faklumc["']\s+href=["']([a-z0-9]+)["']/i);
    if (!match) {
      console.log('[Faklum] Could not extract session token from homepage');
      return null;
    }
    sessionToken = match[1];
    sessionTokenAt = Date.now();
    console.log(`[Faklum] Session token: ${sessionToken}`);
    return sessionToken;
  } catch (e: any) {
    console.log('[Faklum] Session token fetch failed:', e.message);
    return null;
  }
}

// --- films index ---

let filmsIndex: FaklumFilm[] = [];
let filmsIndexAt = 0;

function parseFilm(raw: any): FaklumFilm | null {
  const title: string = raw?.title || '';
  const link: string = raw?.link || '';
  if (!title || !link) return null;

  const yearMatch = title.match(/\((\d{4})\)\s*$/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
  const cleanTitle = yearMatch ? title.slice(0, yearMatch.index).trim() : title.trim();

  const linkMatch = link.match(/\/(\d+)\/?$/);
  if (!linkMatch) return null;

  return {
    id: String(raw.id || ''),
    title,
    year,
    cleanTitle,
    hd: !!raw.hd,
    vostfr: !!raw.vostfr,
    linkId: linkMatch[1],
  };
}

async function fetchPage(token: string, offset: number): Promise<FaklumFilm[]> {
  try {
    const { data } = await axios.get(
      `${FAKLUM_BASE}/${token}/api_films.php?offset=${offset}`,
      { headers: HEADERS, timeout: 10000 }
    );
    if (!Array.isArray(data?.films)) return [];
    return data.films.map(parseFilm).filter((f: FaklumFilm | null): f is FaklumFilm => f !== null);
  } catch {
    return [];
  }
}

async function buildIndex(token: string): Promise<FaklumFilm[]> {
  const films: FaklumFilm[] = [];
  let offset = 0;
  let exhausted = false;

  while (!exhausted && offset < MAX_OFFSET) {
    const batch = await Promise.all(
      Array.from({ length: PARALLEL_PAGES }, (_, i) => fetchPage(token, offset + i * PAGE_SIZE))
    );
    for (const page of batch) {
      if (page.length === 0) {
        exhausted = true;
        continue;
      }
      films.push(...page);
    }
    offset += PARALLEL_PAGES * PAGE_SIZE;
  }

  return films;
}

async function getIndex(): Promise<FaklumFilm[]> {
  if (filmsIndex.length && Date.now() - filmsIndexAt < INDEX_TTL) {
    return filmsIndex;
  }

  const films = await cached<FaklumFilm[]>(
    'faklum:index',
    INDEX_TTL,
    async () => {
      const token = await getSessionToken();
      if (!token) return [];
      const built = await buildIndex(token);
      if (built.length === 0) {
        // Maybe token rotated — retry once with a fresh token
        const fresh = await getSessionToken(true);
        if (fresh && fresh !== token) {
          const retry = await buildIndex(fresh);
          console.log(`[Faklum] Index built (after token refresh): ${retry.length} films`);
          return retry;
        }
      }
      console.log(`[Faklum] Index built: ${built.length} films`);
      return built;
    },
    { scope: 'faklum-index', shouldCache: r => r.length > 0 }
  );

  filmsIndex = films;
  filmsIndexAt = Date.now();
  return films;
}

// --- matching ---

function normalize(s: string): string {
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
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

function findMatches(films: FaklumFilm[], title: string, year: number | null): FaklumFilm[] {
  const normTitle = normalize(title);
  return films
    .map(f => {
      const sim = jaccard(normTitle, normalize(f.cleanTitle));
      const yearDelta = year && f.year ? Math.abs(year - f.year) : 99;
      return { f, sim, yearDelta };
    })
    .filter(({ sim, yearDelta }) => sim >= 0.7 && yearDelta <= 1)
    .sort((a, b) => b.sim - a.sim || a.yearDelta - b.yearDelta)
    .slice(0, 3)
    .map(({ f }) => f);
}

// --- film page → iframe ---

async function getIframeUrl(token: string, linkId: string): Promise<string | null> {
  try {
    // Film pages set a cookie `g=true` on first visit then 302 to themselves.
    // Send it upfront to skip the redirect.
    const { data: html } = await axios.get(
      `${FAKLUM_BASE}/${token}/b/faklum/${linkId}`,
      { headers: { ...HEADERS, Cookie: 'g=true' }, timeout: 10000 }
    );
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    return iframeMatch ? iframeMatch[1] : null;
  } catch (e: any) {
    console.log(`[Faklum] Film page fetch failed for ${linkId}:`, e.message);
    return null;
  }
}

// --- main ---

export async function getFaklumStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  tmdbKey?: string
): Promise<FaklumStream[]> {
  if (mediaType !== 'movie') return []; // Faklum only has films

  const key = `faklum:${mediaType}:${tmdbId}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchFaklumStreams(tmdbId, mediaType, extractorConfig, tmdbKey),
    { scope: 'faklum', shouldCache: r => r.length > 0 }
  );
}

async function fetchFaklumStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  tmdbKey?: string
): Promise<FaklumStream[]> {
  const apiKey = tmdbKey || DEFAULT_TMDB_API_KEY;
  if (!apiKey) {
    console.log('[Faklum] No TMDB API key, skipping');
    return [];
  }

  console.log(`[Faklum] Searching for TMDB ${tmdbId}...`);

  try {
    // Faklum tags films with their French titles (e.g. "Avatar : De feu et de cendres"),
    // so we query TMDB in fr-FR. Falls back to original title when no French localization exists.
    const tmdbData = await cached<any>(
      `tmdb:movie-fr:${tmdbId}`,
      12 * 60 * 60 * 1000,
      async () => {
        const { data } = await axios.get(
          `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=fr-FR`,
          { timeout: 10000 }
        );
        return data;
      },
      { scope: 'tmdb', shouldCache: r => !!r }
    );
    const title: string = tmdbData?.title || tmdbData?.original_title;
    const year = tmdbData?.release_date ? parseInt(tmdbData.release_date.split('-')[0], 10) : null;
    if (!title) return [];

    console.log(`[Faklum] TMDB: ${title} (${year})`);

    const films = await getIndex();
    if (films.length === 0) return [];

    const matches = findMatches(films, title, year);
    if (matches.length === 0) {
      console.log('[Faklum] No matches');
      return [];
    }
    console.log(`[Faklum] ${matches.length} match(es): ${matches.map(m => m.title).join(', ')}`);

    const token = await getSessionToken();
    if (!token) return [];

    const streams: FaklumStream[] = [];
    for (const film of matches) {
      const iframeUrl = await getIframeUrl(token, film.linkId);
      if (!iframeUrl) continue;

      const extracted = await extractStream(iframeUrl, extractorConfig);
      if (!extracted) {
        console.log(`[Faklum] Extraction failed for ${film.title} (iframe: ${iframeUrl})`);
        continue;
      }

      streams.push({
        name: 'Faklum',
        title: film.title,
        url: extracted.url,
        quality: film.hd ? 'HD' : 'SD',
        language: film.vostfr ? 'VOSTFR' : 'VF',
        headers: extracted.headers,
      });
    }

    console.log(`[Faklum] Returning ${streams.length} stream(s)`);
    return streams;
  } catch (e: any) {
    console.log('[Faklum] Error:', e.message);
    return [];
  }
}

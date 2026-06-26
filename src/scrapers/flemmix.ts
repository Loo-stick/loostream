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
  base: 'https://flemmix.fast',
  origin: 'https://flemmix.fast',
  referer: 'https://flemmix.fast/',
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

// Flemmix ships DataLife's AJAX autocomplete endpoint (dle_do_search in
// /public/js/dle_js.js). The old POST /?do=search&story=X form submit no
// longer filters results — the backend just returns the homepage. The
// autocomplete endpoint at /index.php?controller=ajax&mod=search is what
// the browser actually uses and still works.
function parseSearchHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // <a href="..." class="fsr-wrap"> ... <span class="fsr-title">TITLE</span>
  // ... optional <span class="fsr-badge fsr-lang">VF|VOSTFR|TrueFrench</span>
  const itemRegex = /<a href="([^"]+)"[^>]*class="fsr-wrap"[\s\S]*?<span class="fsr-title">([^<]+)<\/span>(?:[\s\S]{0,800}?<span class="fsr-badge fsr-lang">([^<]+)<\/span>)?/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(html)) !== null) {
    const url = m[1].trim();
    // Accept both the new /vf/ and /film-ancien/ URL patterns and the legacy
    // /film-en-streaming/ / /serie-en-streaming/ ones (defensive).
    if (!/\/(?:vf|film-ancien|film-en-streaming|serie-en-streaming)\/\d+-/.test(url)) continue;
    const rawLang = m[3] ? m[3].trim().toLowerCase() : '';
    const language = rawLang.includes('vostfr') ? 'VOSTFR' : 'VF';
    results.push({
      url,
      title: decodeEntities(m[2].trim()),
      origTitle: null,  // autocomplete response doesn't expose the original title
      language,
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

// DataLife autocomplete needs a session: PHPSESSID cookie + dle_login_hash
// + dle_skin (all extracted from the homepage). Cache them because they're
// stable per-visitor for the whole day.
interface FlemmixSession {
  hash: string;
  skin: string;
  cookie: string;
  at: number;
}
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
let cachedSession: FlemmixSession | null = null;

async function getSession(force = false): Promise<FlemmixSession | null> {
  if (!force && cachedSession && Date.now() - cachedSession.at < SESSION_TTL_MS) {
    return cachedSession;
  }
  try {
    const resp = await axios.get(endpoints.base + '/', {
      headers: HEADERS,
      timeout: 10000,
    });
    const hash = resp.data.match(/dle_login_hash\s*=\s*['"]([a-f0-9]+)['"]/)?.[1];
    const skin = resp.data.match(/dle_skin\s*=\s*['"]([^'"]+)['"]/)?.[1];
    const setCookie = resp.headers['set-cookie'] || [];
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .map((c: string) => c.split(';')[0])
      .filter(Boolean)
      .join('; ');
    if (!hash || !skin) {
      console.log('[Flemmix] Could not extract dle_login_hash / dle_skin from homepage');
      return null;
    }
    cachedSession = { hash, skin, cookie, at: Date.now() };
    console.log(`[Flemmix] Session ready (skin=${skin})`);
    return cachedSession;
  } catch (e: any) {
    console.log('[Flemmix] Session fetch failed:', e.message);
    return null;
  }
}

async function searchFilms(query: string): Promise<SearchResult[]> {
  const sess = await getSession();
  if (!sess) return [];
  try {
    const body = new URLSearchParams({
      query,
      skin: sess.skin,
      user_hash: sess.hash,
    }).toString();

    const { data: html } = await axios.post(
      `${endpoints.base}/index.php?controller=ajax&mod=search`,
      body,
      {
        headers: {
          ...HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': endpoints.origin,
          'Referer': endpoints.referer,
          'Cookie': sess.cookie,
        },
        timeout: 10000,
      }
    );
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

// Each season is a separate Flemmix page; the title always ends with " - Saison N".
function parseSeriesTitle(title: string): { base: string; season: number | null } {
  const m = title.match(/^(.*?)\s*-\s*Saison\s+(\d+)\s*$/i);
  if (m) return { base: m[1].trim(), season: parseInt(m[2], 10) };
  return { base: title.trim(), season: null };
}

// Series episode embeds live inside <div class="ep<N>vf"> or <div class="ep<N>vs">
// (VF / VOSTFR). The loadVideo calls there drop the second `this` arg and the
// <span> label is generic ("Lecteur 1"), so we derive the real server from the
// embed URL's hostname.
async function fetchSeriesEpisodeEmbeds(
  filmUrl: string,
  episode: number,
  langPref: 'vf' | 'vs'
): Promise<EmbedLink[]> {
  try {
    const { data: html } = await axios.get(filmUrl, {
      headers: { ...HEADERS, Referer: endpoints.referer },
      timeout: 15000,
    });
    const divRegex = new RegExp(
      `<div[^>]+class="ep${episode}${langPref}"[^>]*>([\\s\\S]*?)<\\/div>`,
      'i'
    );
    const m = html.match(divRegex);
    if (!m) return [];

    const embeds: EmbedLink[] = [];
    const lvRegex = /loadVideo\(\s*['"]([^'"]+)['"]/g;
    let lv: RegExpExecArray | null;
    while ((lv = lvRegex.exec(m[1])) !== null) {
      const url = lv[1].trim();
      let server = 'unknown';
      try {
        server = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
      } catch {
        continue;
      }
      embeds.push({ server, url });
    }
    return embeds;
  } catch (e: any) {
    console.log(`[Flemmix] Series page fetch failed: ${e.message}`);
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
  const apiKey = tmdbKey || DEFAULT_TMDB_API_KEY;
  if (!apiKey) {
    console.log('[Flemmix] No TMDB API key, skipping');
    return [];
  }
  if (mediaType === 'series' && (!season || !episode)) return [];

  const key = `flemmix:${mediaType}:${tmdbId}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchFlemmixStreams(tmdbId, mediaType, apiKey, extractorConfig, season, episode),
    { scope: 'flemmix', shouldCache: r => r.length > 0 }
  );
}

async function fetchFlemmixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  apiKey: string,
  extractorConfig: ExtractorConfig,
  season?: number,
  episode?: number
): Promise<FlemmixStream[]> {
  console.log(`[Flemmix] Searching for TMDB ${tmdbId} (${mediaType}${season ? ` S${season}E${episode}` : ''})...`);

  try {
    // TMDB in fr-FR (films + series use the same cache scope — the id space is
    // disjoint across types so keying by tmdbId alone is fine)
    const tmdbEndpoint = mediaType === 'series' ? 'tv' : 'movie';
    const tmdbData = await cached<any>(
      `tmdb:${tmdbEndpoint}-fr:${tmdbId}`,
      TMDB_TTL_MS,
      async () => {
        const { data } = await axios.get(
          `https://api.themoviedb.org/3/${tmdbEndpoint}/${tmdbId}?api_key=${apiKey}&language=fr-FR`,
          { timeout: 10000 }
        );
        return data;
      },
      { scope: 'tmdb', shouldCache: r => !!r }
    );

    const frTitle: string = tmdbData?.title || tmdbData?.name || tmdbData?.original_title || tmdbData?.original_name;
    const origTitle: string = tmdbData?.original_title || tmdbData?.original_name || '';
    const year = (tmdbData?.release_date || tmdbData?.first_air_date || '').split('-')[0];
    if (!frTitle) return [];

    console.log(`[Flemmix] TMDB: ${frTitle}${year ? ` (${year})` : ''} / orig: ${origTitle}`);

    const searchResults = await searchFilms(frTitle);
    if (searchResults.length === 0) {
      console.log('[Flemmix] No search results');
      return [];
    }

    // For series, strip " - Saison N" from each result before fuzzy matching
    // and keep only results whose season number equals the requested one.
    const normFr = normalize(frTitle);
    const normOrig = origTitle ? normalize(origTitle) : '';
    const ranked = searchResults
      .map(r => {
        const { base, season: parsedSeason } = mediaType === 'series'
          ? parseSeriesTitle(r.title)
          : { base: r.title, season: null };
        const simFr = jaccard(normFr, normalize(base));
        const simOrig = r.origTitle ? jaccard(normOrig || normFr, normalize(r.origTitle)) : 0;
        const sim = Math.max(simFr, simOrig);
        return { r, sim, parsedSeason };
      })
      .filter(({ sim, parsedSeason }) => {
        if (sim < 0.7) return false;
        if (mediaType === 'series') return parsedSeason === season;
        return true;
      })
      .sort((a, b) => b.sim - a.sim);

    if (ranked.length === 0) {
      console.log(`[Flemmix] No fuzzy match above threshold${mediaType === 'series' ? ` for S${season}` : ''}`);
      return [];
    }

    console.log(`[Flemmix] ${ranked.length} match(es), best: ${ranked[0].r.title} (${(ranked[0].sim * 100).toFixed(0)}%)`);

    const best = ranked[0].r;
    // Series episode embeds live per-episode; try VF first, fall back to VOSTFR
    // if the VF block is empty.
    let embeds: EmbedLink[];
    if (mediaType === 'series') {
      embeds = await fetchSeriesEpisodeEmbeds(best.url, episode!, 'vf');
      if (embeds.length === 0) {
        embeds = await fetchSeriesEpisodeEmbeds(best.url, episode!, 'vs');
      }
      if (embeds.length === 0) {
        console.log(`[Flemmix] No embeds for episode S${season}E${episode}`);
        return [];
      }
    } else {
      embeds = await fetchFilmEmbeds(best.url);
      if (embeds.length === 0) {
        console.log('[Flemmix] No embeds on film page');
        return [];
      }
    }

    // Filter only embeds we can resolve (MFP or local)
    const supported = embeds.filter(e => {
      try { return detectExtractor(e.url) !== null; } catch { return false; }
    });
    console.log(`[Flemmix] ${embeds.length} embeds, ${supported.length} supported: ${supported.map(e => e.server).join(', ')}`);

    // Embeds rejetés : signale chaque hôte non reconnu (le bot Telegram grep ça).
    for (const e of embeds.filter(e => !supported.includes(e))) {
      let host = e.url;
      try { host = new URL(e.url).hostname; } catch { /* garde l'URL brute */ }
      console.log(`[Flemmix] Unrecognized host: ${host} (server="${e.server}", title="${frTitle}")`);
    }

    // Dedupe per server BEFORE extraction to avoid wasting parallel calls on
    // the same server (we'd only keep one anyway). VOSTFR embeds are listed
    // last on the page, so keep them at the front — the cap must never drop them.
    const seen = new Set<string>();
    const dedupedEmbeds = supported
      .filter(embed => {
        if (seen.has(embed.server)) return false;
        seen.add(embed.server);
        return true;
      })
      .sort((a, b) => (/vostfr/i.test(a.server) ? 0 : 1) - (/vostfr/i.test(b.server) ? 0 : 1))
      .slice(0, 12);

    const extracted = await Promise.all(
      dedupedEmbeds.map(async embed => {
        const r = await extractStream(embed.url, extractorConfig);
        if (!r) {
          console.log(`[Flemmix] Extraction failed for ${embed.server} (${embed.url})`);
          return null;
        }
        console.log(`[Flemmix] Extracted ${embed.server}: ${r.format}`);
        return { embed, r };
      })
    );

    const streams: FlemmixStream[] = [];
    for (const item of extracted) {
      if (!item) continue;
      streams.push({
        name: 'Flemmix',
        title: best.title,
        url: item.r.url,
        quality: item.r.quality || 'HD',
        language: /vostfr/i.test(item.embed.server) ? 'VOSTFR' : best.language,
        server: item.embed.server.toLowerCase(),
        headers: item.r.headers,
      });
    }

    console.log(`[Flemmix] Returning ${streams.length} stream(s)`);
    return streams;
  } catch (e: any) {
    console.log('[Flemmix] Error:', e.message);
    return [];
  }
}

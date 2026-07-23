import express from 'express';
import axios from 'axios';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { getNetmirrorStreams } from './scrapers/netmirror';
import { getCinemaosStreams, reloadCinemaosConfig, isCinemaosEnabled } from './scrapers/cinemaos';
import { getStreamFlixStreams } from './scrapers/streamflix';
import { getMovixStreams, reloadMovixEndpoints, getMovixEndpoints } from './scrapers/movix';
import { getFaklumStreams } from './scrapers/faklum';
import { getFlemmixStreams, reloadFlemmixEndpoints, getFlemmixEndpoints } from './scrapers/flemmix';
import { getFrenchStreamStreams, reloadFrenchStreamEndpoints, getFrenchStreamEndpoints } from './scrapers/frenchstream';
import { cached, getCacheStats } from './cache';
import { recordOutcome, getAllMetrics } from './metrics';
import crypto from 'crypto';
import proxyRouter, { isAllowedUrl } from './proxy';
import { ExtractorConfig, reloadExtractorDomains, getExtractorDomains } from './extractors';
import { getSceneMeta, buildFilename, providerLabel } from './filename';

const app = express();

// Trust proxy (for reverse proxies like Apache/Nginx)
app.set('trust proxy', 1);

// ============================================
// STATS TRACKING
// ============================================
interface Stats {
  startTime: number;
  requests: {
    total: number;
    streams: number;
    proxy: number;
  };
  sources: {
    movix: { requests: number; success: number; errors: number; lastSuccess: number | null };
    netmirror: { requests: number; success: number; errors: number; lastSuccess: number | null };
    streamflix: { requests: number; success: number; errors: number; lastSuccess: number | null };
    faklum: { requests: number; success: number; errors: number; lastSuccess: number | null };
    flemmix: { requests: number; success: number; errors: number; lastSuccess: number | null };
    frenchstream: { requests: number; success: number; errors: number; lastSuccess: number | null };
    cinemaos: { requests: number; success: number; errors: number; lastSuccess: number | null };
  };
  streamsServed: {
    movix: number;
    netmirror: number;
    streamflix: number;
    faklum: number;
    flemmix: number;
    frenchstream: number;
    cinemaos: number;
  };
}

const stats: Stats = {
  startTime: Date.now(),
  requests: { total: 0, streams: 0, proxy: 0 },
  sources: {
    movix: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    netmirror: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    streamflix: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    faklum: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    flemmix: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    frenchstream: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    cinemaos: { requests: 0, success: 0, errors: 0, lastSuccess: null },
  },
  streamsServed: { movix: 0, netmirror: 0, streamflix: 0, faklum: 0, flemmix: 0, frenchstream: 0, cinemaos: 0 },
};

function trackSourceResult(source: 'movix' | 'netmirror' | 'streamflix' | 'faklum' | 'flemmix' | 'frenchstream' | 'cinemaos', success: boolean, streamCount: number = 0) {
  stats.sources[source].requests++;
  if (success) {
    stats.sources[source].success++;
    stats.sources[source].lastSuccess = Date.now();
    stats.streamsServed[source] += streamCount;
  } else {
    stats.sources[source].errors++;
  }
}

// ============================================
// SECURITY: Rate limiting (100 requests per minute per IP)
// ============================================
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for proxy segment requests (high volume during streaming)
    return req.path.includes('/proxy/segment');
  },
});
const PORT = process.env.PORT || 7002;

// Default config from env
const DEFAULT_USE_LOCAL_PROXY = process.env.USE_LOCAL_PROXY === 'true';
const DEFAULT_MEDIAFLOW_URL = process.env.MEDIAFLOW_URL || '';
const DEFAULT_MEDIAFLOW_PASSWORD = process.env.MEDIAFLOW_PASSWORD || '';

// User config interface
interface UserConfig {
  proxy: 'local' | 'mediaflow';
  mfUrl?: string;
  mfPass?: string;
  tmdbKey?: string;
  prefQuality?: string;  // "1080p", "4K", "720p", "480p"
  langOrder?: string[];  // ["MULTI", "VF", "VOSTFR", "VO"]
}

// Stream with metadata for filtering/sorting
interface StreamWithMeta {
  name: string;
  title: string;
  url: string;
  behaviorHints: { notWebReady: boolean; bingeGroup: string; filename?: string };
  subtitles?: { id: string; url: string; lang: string }[];
  _meta: {
    quality: string;
    language: string;
    source: string;
  };
}

// ============================================
// SECURITY: Config validation
// ============================================
function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function sanitizeString(str: string, maxLength: number = 200): string {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLength).replace(/[<>]/g, ''); // Remove potential XSS chars
}

// Parse and validate config from base64 URL param
function parseConfig(configStr: string): UserConfig | null {
  try {
    // Limit config string length to prevent DoS
    if (configStr.length > 2000) {
      console.warn('[Config] Config string too long');
      return null;
    }

    const decoded = Buffer.from(configStr, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);

    // Validate proxy type
    if (!['local', 'mediaflow'].includes(parsed.proxy)) {
      console.warn('[Config] Invalid proxy type');
      return null;
    }

    // Validate MediaFlow URL if provided
    if (parsed.mfUrl && !isValidUrl(parsed.mfUrl)) {
      console.warn('[Config] Invalid MediaFlow URL');
      return null;
    }

    // Validate preferences
    const validQualities = ['4K', '1080p', '720p', '480p'];
    const validLangs = ['MULTI', 'VF', 'VOSTFR', 'VO'];

    let prefQuality = parsed.prefQuality;
    if (prefQuality && !validQualities.includes(prefQuality)) {
      prefQuality = '1080p'; // Default
    }

    let langOrder = parsed.langOrder;
    if (langOrder && Array.isArray(langOrder)) {
      // Filter to valid languages only
      langOrder = langOrder.filter((l: string) => validLangs.includes(l));
      if (langOrder.length === 0) langOrder = undefined;
    } else {
      langOrder = undefined;
    }

    // Sanitize strings
    return {
      proxy: parsed.proxy,
      mfUrl: parsed.mfUrl ? sanitizeString(parsed.mfUrl, 500) : undefined,
      mfPass: parsed.mfPass ? sanitizeString(parsed.mfPass, 100) : undefined,
      tmdbKey: parsed.tmdbKey ? sanitizeString(parsed.tmdbKey, 64) : undefined,
      prefQuality,
      langOrder,
    };
  } catch {
    return null;
  }
}

// ============================================
// STREAM FILTERING AND SORTING
// ============================================
const DEFAULT_LANG_ORDER = ['MULTI', 'VF', 'VOSTFR', 'VO'];
const QUALITY_SCORES: Record<string, number> = {
  '4K': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1,
  'HD': 2, // Treat HD as 720p equivalent
};

function normalizeLanguage(lang: string): string {
  const upper = lang.toUpperCase();
  if (upper.includes('MULTI')) return 'MULTI';
  if (upper.includes('VOSTFR') || upper.includes('VOST')) return 'VOSTFR';
  if (upper.includes('VF') || upper === 'FRENCH' || upper === 'FRANÇAIS') return 'VF';
  if (upper.includes('VO') || upper === 'ORIGINAL' || upper === 'EN' || upper === 'ENGLISH') return 'VO';
  return 'VO'; // Default to VO for unknown
}

function normalizeQuality(quality: string): string {
  const upper = quality.toUpperCase();
  if (upper.includes('4K') || upper.includes('2160')) return '4K';
  if (upper.includes('1080')) return '1080p';
  if (upper.includes('720')) return '720p';
  if (upper.includes('480') || upper.includes('SD')) return '480p';
  if (upper.includes('HD') || upper.includes('FULL')) return '1080p';
  return '720p'; // Default
}

function filterAndSortStreams(streams: StreamWithMeta[], config: UserConfig | null): StreamWithMeta[] {
  if (!config) return streams;

  const prefQuality = config.prefQuality || '1080p';
  const langOrder = config.langOrder || DEFAULT_LANG_ORDER;
  const prefQualityScore = QUALITY_SCORES[prefQuality] || 3;

  // Filter streams based on preferences
  let filtered = streams.filter(stream => {
    const meta = stream._meta;

    // NetMirror (Original) always passes - it's multi-language content
    if (meta.source === 'netmirror') return true;

    // Check if language is in user's preference list
    const normalizedLang = normalizeLanguage(meta.language);
    if (!langOrder.includes(normalizedLang)) return false;

    // Check quality (allow preferred or higher)
    const streamQualityScore = QUALITY_SCORES[normalizeQuality(meta.quality)] || 2;
    if (streamQualityScore < prefQualityScore - 1) return false; // Allow one step lower

    return true;
  });

  // If filtering removed everything, return original streams sorted
  if (filtered.length === 0) {
    filtered = streams;
  }

  // Sort by preference score
  filtered.sort((a, b) => {
    const aLang = normalizeLanguage(a._meta.language);
    const bLang = normalizeLanguage(b._meta.language);
    const aQuality = normalizeQuality(a._meta.quality);
    const bQuality = normalizeQuality(b._meta.quality);

    // Language priority (lower index = higher priority)
    const aLangScore = langOrder.indexOf(aLang);
    const bLangScore = langOrder.indexOf(bLang);
    const aLangPriority = aLangScore === -1 ? 100 : aLangScore;
    const bLangPriority = bLangScore === -1 ? 100 : bLangScore;

    if (aLangPriority !== bLangPriority) {
      return aLangPriority - bLangPriority;
    }

    // Quality priority (higher score = better)
    const aQualityScore = QUALITY_SCORES[aQuality] || 2;
    const bQualityScore = QUALITY_SCORES[bQuality] || 2;

    // Prefer streams closest to preferred quality
    const aDiff = Math.abs(aQualityScore - prefQualityScore);
    const bDiff = Math.abs(bQualityScore - prefQualityScore);

    if (aDiff !== bDiff) {
      return aDiff - bDiff;
    }

    // Tie-breaker: higher quality wins
    return bQualityScore - aQualityScore;
  });

  return filtered;
}

// Check if HLS manifest needs transformer (has .jpg segments that are actually .ts)
async function needsTransformer(hlsUrl: string): Promise<boolean> {
  try {
    const headers = {
      'Referer': 'https://net52.cc/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    const resp = await axios.get(hlsUrl, { headers, timeout: 5000 });
    const manifest = resp.data;

    // Check master manifest for .jpg
    if (manifest.includes('.jpg')) {
      return true;
    }

    // Check first variant playlist for .jpg segments
    const variantMatch = manifest.match(/https?:\/\/[^\s]+\.m3u8[^\s]*/);
    if (variantMatch) {
      try {
        const variantResp = await axios.get(variantMatch[0], { headers, timeout: 5000 });
        if (variantResp.data.includes('.jpg')) {
          return true;
        }
      } catch {
        // Ignore variant check errors
      }
    }

    return false;
  } catch {
    return false;
  }
}

// Check if URL is HLS or direct file
function isHlsUrl(url: string): boolean {
  return url.includes('.m3u8');
}

// Build proxy URL (local or MediaFlow)
function buildProxyUrl(
  streamUrl: string,
  headers: Record<string, string>,
  useTransformer: boolean = false,
  req?: express.Request,
  config?: UserConfig | null,
  forceLocal: boolean = false,
  forceHls: boolean = false
): string | null {
  // SECURITY: Validate stream URL before proxying (applies to both local and MediaFlow)
  const validation = isAllowedUrl(streamUrl);
  if (!validation.allowed) {
    console.warn(`[BuildProxy] Blocked URL: ${validation.reason} - ${streamUrl}`);
    return null; // Return null for blocked URLs
  }

  // forceLocal: some sources (NetMirror netfree HLS) require the local proxy —
  // their segment token is bound to the fetcher's IP and segments are .jpg-disguised
  // mpeg-ts that only the local /proxy transformer rewrites to video/mp2t.
  const useLocal = forceLocal || (config ? config.proxy === 'local' : DEFAULT_USE_LOCAL_PROXY);
  const mfUrl = config?.mfUrl || DEFAULT_MEDIAFLOW_URL;
  const mfPass = config?.mfPass || DEFAULT_MEDIAFLOW_PASSWORD;

  if (useLocal && req) {
    // Use local proxy
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    // Choose endpoint based on stream type
    const endpoint = (forceHls || isHlsUrl(streamUrl)) ? '/proxy/manifest' : '/proxy/stream';
    const proxyUrl = new URL(endpoint, baseUrl);
    proxyUrl.searchParams.set('url', streamUrl);

    if (useTransformer) {
      proxyUrl.searchParams.set('transformer', 'ts_stream');
    }

    // NetMirror (forceLocal) masters carry 20+ audio tracks; trim to the useful
    // languages so the player doesn't fetch every rendition before playback.
    // The DEFAULT track (original/VO) is always kept by the proxy on top of these.
    if (forceLocal) {
      proxyUrl.searchParams.set('audio', 'fr,en,und');
    }

    for (const [key, value] of Object.entries(headers)) {
      proxyUrl.searchParams.set(`h_${key.toLowerCase()}`, value);
    }

    return proxyUrl.toString();
  } else {
    // Use MediaFlow
    if (!mfUrl) {
      console.error('[Proxy] MediaFlow URL not configured!');
      return streamUrl; // Fallback to direct URL
    }

    // HLS -> MediaFlow HLS proxy; direct files (mp4/mkv) -> MediaFlow stream proxy
    // (forwards Range for seeking). Sending an mp4 to the HLS endpoint 403s.
    const endpoint = (forceHls || isHlsUrl(streamUrl)) ? '/proxy/hls/manifest.m3u8' : '/proxy/stream';
    const proxyUrl = new URL(endpoint, mfUrl);
    proxyUrl.searchParams.set('api_password', mfPass);
    proxyUrl.searchParams.set('d', streamUrl);

    if (useTransformer) {
      proxyUrl.searchParams.set('transformer', 'ts_stream');
    }

    for (const [key, value] of Object.entries(headers)) {
      proxyUrl.searchParams.set(`h_${key.toLowerCase()}`, value);
    }

    return proxyUrl.toString();
  }
}

// CORS for Stremio
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// Apply global rate limiting (100 req/min for API, applies to all routes)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use(apiLimiter as any);

// Local HLS proxy (has its own higher limit via proxyLimiter applied internally if needed)
app.use('/proxy', proxyRouter);

// Manifest generator
function getManifest(req: express.Request) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const baseUrl = `${proto}://${host}`;

  return {
    id: 'community.loostream.stremio',
    version: '1.4.0',
    name: 'LooStream',
    logo: `${baseUrl}/logo.png`,
    description: 'Netflix, Prime, Disney+ mirrors + StreamFlix + Movix VF/VOSTFR',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt', 'tmdb:'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}

// Configure page
app.get('/configure', (_req, res) => {
  res.sendFile(path.join(__dirname, 'configure.html'));
});

// Configure page with existing config (allows reconfiguration)
app.get('/:config/configure', (_req, res) => {
  res.sendFile(path.join(__dirname, 'configure.html'));
});

// Manifest without config (uses env defaults)
app.get('/manifest.json', (req, res) => {
  res.json(getManifest(req));
});

// Manifest with config
app.get('/:config/manifest.json', (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config) {
    return res.status(400).json({ error: 'Invalid configuration' });
  }
  res.json(getManifest(req));
});

// TMDB API helper
const DEFAULT_TMDB_KEY = process.env.TMDB_API_KEY || '';

const TMDB_TTL_MS = 12 * 60 * 60 * 1000;

async function getTmdbInfo(type: string, id: string, config?: UserConfig | null): Promise<{ title: string; year: string; tmdbId: string; imdbId: string; originalLanguage: string } | null> {
  const tmdbKey = config?.tmdbKey || DEFAULT_TMDB_KEY;

  if (!tmdbKey) {
    console.error('[TMDB] No API key configured!');
    return null;
  }

  return cached(
    `tmdb:info:${type}:${id}`,
    TMDB_TTL_MS,
    async () => {
      try {
        let tmdbId = id;

        if (id.startsWith('tt')) {
          const findResp = await axios.get(
            `https://api.themoviedb.org/3/find/${id}?api_key=${tmdbKey}&external_source=imdb_id`
          );
          const results = type === 'movie' ? findResp.data.movie_results : findResp.data.tv_results;
          if (!results || results.length === 0) return null;
          tmdbId = String(results[0].id);
        } else if (id.startsWith('tmdb:')) {
          tmdbId = id.replace('tmdb:', '').split(':')[0];
        }

        const endpoint = type === 'movie' ? 'movie' : 'tv';
        const resp = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${tmdbKey}`);

        const title = resp.data.title || resp.data.name;
        const year = (resp.data.release_date || resp.data.first_air_date || '').split('-')[0];

        let imdbId = id.startsWith('tt') ? id : (resp.data.imdb_id || '');
        if (!imdbId) {
          try {
            const ext = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${tmdbKey}`);
            imdbId = ext.data?.imdb_id || '';
          } catch { /* imdbId optional */ }
        }

        const originalLanguage = String(resp.data.original_language || '').toLowerCase();

        return { title, year, tmdbId, imdbId, originalLanguage };
      } catch (e) {
        console.error('[TMDB] Error:', e);
        return null;
      }
    },
    { scope: 'tmdb', shouldCache: r => r !== null }
  );
}

// Parse Stremio ID
function parseStremioId(id: string): { baseId: string; season?: number; episode?: number } {
  // Format: tt1234567 or tt1234567:1:1 or tmdb:12345 or tmdb:12345:1:1
  const parts = id.split(':');

  if (id.startsWith('tmdb:')) {
    return {
      baseId: `tmdb:${parts[1]}`,
      season: parts[2] ? parseInt(parts[2]) : undefined,
      episode: parts[3] ? parseInt(parts[3]) : undefined,
    };
  }

  // IMDB format: tt1234567 or tt1234567:1:1
  return {
    baseId: parts[0], // Just the tt1234567 part
    season: parts[1] ? parseInt(parts[1]) : undefined,
    episode: parts[2] ? parseInt(parts[2]) : undefined,
  };
}

// Stream handler (shared logic)
async function handleStream(req: express.Request, res: express.Response, type: string, id: string, config: UserConfig | null) {
  console.log(`[Stream] Request for ${type}/${id} (proxy: ${config?.proxy || 'default'})`);

  try {
    const parsed = parseStremioId(decodeURIComponent(id));
    const info = await getTmdbInfo(type, parsed.baseId, config);

    if (!info) {
      console.log('[Stream] Could not get TMDB info');
      return res.json({ streams: [] });
    }

    console.log(`[Stream] Title: ${info.title} (${info.year})`);

    // Fetch from all sources in parallel (with stats tracking)
    stats.requests.total++;
    stats.requests.streams++;

    // Build extractor config based on user settings
    const extractorConfig: ExtractorConfig = {
      useMediaFlow: config?.proxy !== 'local',
      mediaFlowUrl: config?.mfUrl || DEFAULT_MEDIAFLOW_URL,
      mediaFlowPassword: config?.mfPass || DEFAULT_MEDIAFLOW_PASSWORD,
    };

    const [netmirrorResults, streamflixResults, movixResults, faklumResults, flemmixResults, frenchstreamResults, cinemaosResults] = await Promise.all([
      getNetmirrorStreams(info.title, info.year, type as 'movie' | 'series', parsed.season, parsed.episode, info.originalLanguage)
        .then(r => { trackSourceResult('netmirror', true, r.length); recordOutcome('netmirror', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[NetMirror] Error:', e); trackSourceResult('netmirror', false); recordOutcome('netmirror', 'error', e?.message); return []; }),
      getStreamFlixStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, config?.tmdbKey || DEFAULT_TMDB_KEY)
        .then(r => { trackSourceResult('streamflix', true, r.length); recordOutcome('streamflix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[StreamFlix] Error:', e); trackSourceResult('streamflix', false); recordOutcome('streamflix', 'error', e?.message); return []; }),
      getMovixStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, extractorConfig)
        .then(r => { trackSourceResult('movix', true, r.length); recordOutcome('movix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Movix] Error:', e); trackSourceResult('movix', false); recordOutcome('movix', 'error', e?.message); return []; }),
      getFaklumStreams(info.tmdbId, type as 'movie' | 'series', extractorConfig, config?.tmdbKey || DEFAULT_TMDB_KEY)
        .then(r => { trackSourceResult('faklum', true, r.length); recordOutcome('faklum', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Faklum] Error:', e); trackSourceResult('faklum', false); recordOutcome('faklum', 'error', e?.message); return []; }),
      getFlemmixStreams(info.tmdbId, type as 'movie' | 'series', extractorConfig, config?.tmdbKey || DEFAULT_TMDB_KEY, parsed.season, parsed.episode)
        .then(r => { trackSourceResult('flemmix', true, r.length); recordOutcome('flemmix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Flemmix] Error:', e); trackSourceResult('flemmix', false); recordOutcome('flemmix', 'error', e?.message); return []; }),
      getFrenchStreamStreams(info.tmdbId, type as 'movie' | 'series', extractorConfig, config?.tmdbKey || DEFAULT_TMDB_KEY, parsed.season, parsed.episode)
        .then(r => { trackSourceResult('frenchstream', true, r.length); recordOutcome('frenchstream', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[FrenchStream] Error:', e); trackSourceResult('frenchstream', false); recordOutcome('frenchstream', 'error', e?.message); return []; }),
      getCinemaosStreams(info.tmdbId, info.imdbId, type as 'movie' | 'series', info.title, info.year, parsed.season, parsed.episode)
        .then(r => { if (isCinemaosEnabled()) { trackSourceResult('cinemaos', true, r.length); recordOutcome('cinemaos', r.length > 0 ? 'success' : 'empty'); } return r; })
        .catch(e => { console.log('[CinemaOS] Error:', e); if (isCinemaosEnabled()) { trackSourceResult('cinemaos', false); recordOutcome('cinemaos', 'error', e?.message); } return []; }),
    ]);

    const streams: StreamWithMeta[] = [];

    // Process Movix results
    for (const mv of movixResults) {
      let finalUrl: string;

      // Check if URL is already a MediaFlow URL (from extractor)
      const mfUrl = config?.mfUrl || DEFAULT_MEDIAFLOW_URL;
      const isMediaFlowUrl = mfUrl && mv.url.includes(new URL(mfUrl).hostname);

      if (isMediaFlowUrl) {
        // Already a MediaFlow URL, use directly
        finalUrl = mv.url;
      } else {
        // Need to proxy (Purstream direct URLs or local extraction results)
        // Merge default headers with extractor-provided headers
        const proxyHeaders: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...mv.headers, // Headers from extractor (e.g., Referer)
        };
        const proxiedUrl = buildProxyUrl(mv.url, proxyHeaders, false, req, config);

        if (!proxiedUrl) continue; // Skip blocked URLs
        finalUrl = proxiedUrl;
      }

      const serverLabel = mv.server ? ` • ${mv.server}` : '';
      streams.push({
        name: `Movix\n${mv.language}`,
        title: `${mv.language} [${mv.quality}]${serverLabel}`,
        url: finalUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: 'movix',
        },
        _meta: {
          quality: mv.quality,
          language: mv.language,
          source: 'movix',
        },
      });
    }

    // Process NetMirror results (netfree multi-audio HLS master). MUST go through
    // the LOCAL proxy: the segment token is IP-bound to the fetcher and the .jpg
    // segments need the local transformer -> video/mp2t. One adaptive stream per
    // platform; the player picks the audio track (VO + VF when available).
    for (const r of netmirrorResults) {
      // Master RECONSTRUIT servi par l'addon (le master d'origine = placeholder).
      const mu = new URL('/netmirror/master.m3u8', nmSegBase(req));
      mu.searchParams.set('h', r.cdnHost);
      mu.searchParams.set('id', r.contentId);
      mu.searchParams.set('p', r.prefix);
      mu.searchParams.set('n', String(r.segments));
      mu.searchParams.set('d', r.avgDur.toFixed(3));
      mu.searchParams.set('q', r.qualities.join(','));
      mu.searchParams.set('a', r.audioLangs.map(a => `${a.index}:${a.code}:${encodeURIComponent(a.name)}`).join(','));
      if (r.subtitles?.length) {
        mu.searchParams.set('s', r.subtitles
          .map(t => `${t.code}:${encodeURIComponent(t.name)}:${encodeURIComponent(t.uri)}`).join(','));
      }
      const proxiedUrl = mu.toString();

      streams.push({
        name: `NetMirror ${r.platform}\n${r.quality}`,
        title: `${r.language} [${r.quality}]`,
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: `netmirror-${r.platform}`,
        },
        _meta: {
          quality: r.quality,
          language: r.language,
          source: 'netmirror',
        },
      });
    }

    // Process StreamFlix results
    for (const sf of streamflixResults) {
      const proxiedUrl = buildProxyUrl(sf.url, {
        'Referer': 'https://api.streamflix.app/',
        'Origin': 'https://api.streamflix.app',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, false, req, config);

      if (!proxiedUrl) continue; // Skip blocked URLs

      streams.push({
        name: `StreamFlix\n${sf.quality}`,
        title: `${sf.language} [${sf.quality}]`,
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: 'streamflix',
        },
        _meta: {
          quality: sf.quality,
          language: sf.language,
          source: 'streamflix',
        },
      });
    }

    // Process CinemaOS results (aggregated HLS + per-source subtitles). Many HLS
    // masters have a .txt extension, so force HLS routing based on the source type.
    for (const cs of cinemaosResults) {
      const proxiedUrl = buildProxyUrl(cs.url, {
        ...cs.headers,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, false, req, config, false, cs.isHls);

      if (!proxiedUrl) continue; // Skip blocked URLs

      streams.push({
        name: `CinemaOS ${cs.server}`,
        title: `${cs.language} [${cs.quality}]`,
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: `cinemaos-${cs.server}`,
        },
        subtitles: cs.subtitles.map((s, i) => ({ id: `cinemaos-${i}-${s.lang}`, url: s.url, lang: s.lang })),
        _meta: {
          quality: cs.quality,
          language: cs.language,
          source: 'cinemaos',
        },
      });
    }

    // Process Flemmix results
    for (const fx of flemmixResults) {
      let finalUrl: string;

      const mfUrl = config?.mfUrl || DEFAULT_MEDIAFLOW_URL;
      const isMediaFlowUrl = mfUrl && fx.url.includes(new URL(mfUrl).hostname);

      if (isMediaFlowUrl) {
        finalUrl = fx.url;
      } else {
        const proxyHeaders: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...fx.headers,
        };
        const proxiedUrl = buildProxyUrl(fx.url, proxyHeaders, false, req, config);
        if (!proxiedUrl) continue;
        finalUrl = proxiedUrl;
      }

      streams.push({
        name: `Flemmix\n${fx.language}`,
        title: `${fx.language} [${fx.quality}] • ${fx.server}`,
        url: finalUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: 'flemmix',
        },
        _meta: {
          quality: fx.quality,
          language: fx.language,
          source: 'flemmix',
        },
      });
    }

    // Process Faklum results
    for (const fk of faklumResults) {
      let finalUrl: string;

      const mfUrl = config?.mfUrl || DEFAULT_MEDIAFLOW_URL;
      const isMediaFlowUrl = mfUrl && fk.url.includes(new URL(mfUrl).hostname);

      if (isMediaFlowUrl) {
        finalUrl = fk.url;
      } else {
        const proxyHeaders: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...fk.headers,
        };
        const proxiedUrl = buildProxyUrl(fk.url, proxyHeaders, false, req, config);
        if (!proxiedUrl) continue;
        finalUrl = proxiedUrl;
      }

      streams.push({
        name: `Faklum\n${fk.language}`,
        title: `${fk.language} [${fk.quality}]`,
        url: finalUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: 'faklum',
        },
        _meta: {
          quality: fk.quality,
          language: fk.language,
          source: 'faklum',
        },
      });
    }

    // Process FrenchStream results
    for (const fr of frenchstreamResults) {
      let finalUrl: string;

      const mfUrl = config?.mfUrl || DEFAULT_MEDIAFLOW_URL;
      const isMediaFlowUrl = mfUrl && fr.url.includes(new URL(mfUrl).hostname);

      if (isMediaFlowUrl) {
        finalUrl = fr.url;
      } else {
        const proxyHeaders: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...fr.headers,
        };
        const proxiedUrl = buildProxyUrl(fr.url, proxyHeaders, false, req, config);
        if (!proxiedUrl) continue;
        finalUrl = proxiedUrl;
      }

      streams.push({
        name: `FrenchStream\n${fr.language}`,
        title: `${fr.language} [${fr.quality}] • ${fr.server}`,
        url: finalUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: 'frenchstream',
        },
        _meta: {
          quality: fr.quality,
          language: fr.language,
          source: 'frenchstream',
        },
      });
    }

    if (streams.length === 0) {
      console.log('[Stream] No streams found');
      return res.json({ streams: [] });
    }

    // Add scene-style behaviorHints.filename so meta-addons (AIOStreams) can
    // parse title/year/S-E/resolution/lang. Title comes from Cinemeta (English/
    // scene) rather than the source site (often FR/translated).
    const sceneMeta = await getSceneMeta(
      type === 'series' ? 'series' : 'movie',
      parsed.baseId,
      { title: info.title, year: info.year }
    );
    for (const s of streams) {
      s.behaviorHints.filename = buildFilename({
        title: sceneMeta.title,
        year: sceneMeta.year,
        isSeries: type === 'series',
        season: parsed.season,
        episode: parsed.episode,
        lang: s._meta.language,
        resolution: s._meta.quality,
        provider: providerLabel(s._meta.source),
      });
    }

    // Apply user preferences (filter + sort)
    const sortedStreams = filterAndSortStreams(streams, config);

    // Remove _meta before sending to Stremio (internal use only)
    const cleanStreams = sortedStreams.map(({ _meta, ...rest }) => rest);

    // Count actual streams by source (after filtering blocked URLs)
    const movixCount = streams.filter(s => s._meta?.source === 'movix').length;
    const netmirrorCount = streams.filter(s => s._meta?.source === 'netmirror').length;
    const streamflixCount = streams.filter(s => s._meta?.source === 'streamflix').length;
    const cinemaosCount = streams.filter(s => s._meta?.source === 'cinemaos').length;

    console.log(`[Stream] Returning ${cleanStreams.length} streams (Movix: ${movixCount}, NetMirror: ${netmirrorCount}, StreamFlix: ${streamflixCount}, CinemaOS: ${cinemaosCount})`);
    res.json({ streams: cleanStreams });
  } catch (e) {
    console.error('[Stream] Error:', e);
    res.json({ streams: [] });
  }
}

// Stream endpoint (without config - uses env defaults)
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  await handleStream(req, res, type, id, null);
});

// Stream endpoint (with config)
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const { config, type, id } = req.params;
  const userConfig = parseConfig(config);
  if (!userConfig) {
    return res.status(400).json({ error: 'Invalid configuration' });
  }
  await handleStream(req, res, type, id, userConfig);
});

// Logo
app.get('/logo.png', (_req, res) => {
  res.sendFile('loostream.png', { root: process.cwd() });
});

// Home redirect
app.get('/', (_req, res) => {
  res.redirect('/manifest.json');
});

// ============================================
// ADMIN DASHBOARD — session cookie auth
// ============================================

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const ADMIN_COOKIE = 'loostream_admin';

function signSession(payload: string): string {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySession(token: string | undefined): { user: string; exp: number } | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (!parsed.user || !parsed.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function createSession(user: string): string {
  const payload = Buffer.from(JSON.stringify({ user, exp: Date.now() + SESSION_MAX_AGE_MS })).toString('base64');
  return signSession(payload);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function requireAdminSession(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    res.status(503).send('Admin dashboard not configured. Set ADMIN_USER and ADMIN_PASS in .env');
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies[ADMIN_COOKIE]);
  if (!session) {
    res.redirect('/admin/login' + (cookies[ADMIN_COOKIE] ? '?error=expired' : ''));
    return;
  }
  next();
}

app.get('/admin/login', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (verifySession(cookies[ADMIN_COOKIE])) {
    res.redirect('/admin');
    return;
  }
  res.sendFile('login.html', { root: path.join(__dirname) });
});

app.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    res.redirect('/admin/login?error=notconfig');
    return;
  }
  const { user, pass } = req.body || {};
  if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) {
    const token = createSession(user);
    const secure = (req.headers['x-forwarded-proto'] || req.protocol) === 'https';
    res.cookie(ADMIN_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_MS,
      path: '/',
    });
    res.redirect('/admin');
    return;
  }
  res.redirect('/admin/login?error=invalid');
});

app.post('/admin/logout', (_req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.redirect('/admin/login');
});

app.get('/admin', requireAdminSession, (_req, res) => {
  res.sendFile('admin.html', { root: path.join(__dirname) });
});

// ============================================
// ADMIN API (for Telegram bot)
// ============================================

// Movix endpoints admin (read + reload)
app.get('/api/movix/endpoints', (req, res) => {
  const reload = req.query.reload === 'true';
  const current = reload ? reloadMovixEndpoints() : getMovixEndpoints();
  res.json({ ...current, reloaded: reload });
});

// Flemmix endpoints admin (read + reload)
app.get('/api/flemmix/endpoints', (req, res) => {
  const reload = req.query.reload === 'true';
  const current = reload ? reloadFlemmixEndpoints() : getFlemmixEndpoints();
  res.json({ ...current, reloaded: reload });
});

// FrenchStream endpoints admin (read + reload)
app.get('/api/frenchstream/endpoints', (req, res) => {
  const reload = req.query.reload === 'true';
  const current = reload ? reloadFrenchStreamEndpoints() : getFrenchStreamEndpoints();
  res.json({ ...current, reloaded: reload });
});

// Extractor domains admin (read + reload)
app.get('/api/extractor-domains', (req, res) => {
  const reload = req.query.reload === 'true';
  const current = reload ? reloadExtractorDomains() : getExtractorDomains();
  res.json({ ...current, reloaded: reload });
});

// ── NetMirror : manifestes RECONSTRUITS (méthode Onyx) ─────────────────────────
// Le master d'origine ne renvoie que le placeholder invité ; on génère nous-mêmes
// le master (pistes audio réelles + variantes vidéo) et les playlists vidéo, en
// pointant les segments .jpg (MPEG-TS déguisé) sur /proxy/segment?transform=ts.
const NM_REFERER = 'https://net52.cc/';

function nmSegBase(req: express.Request): string {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// `ts` = appliquer le transformer MPEG-TS (.jpg -> video/mp2t). À NE PAS activer
// pour les sous-titres : leurs segments sont du WebVTT, pas de la vidéo.
function nmProxy(base: string, target: string, kind: 'segment' | 'manifest', ts = true): string {
  const u = new URL(`/proxy/${kind}`, base);
  u.searchParams.set('url', target);
  u.searchParams.set('h_referer', NM_REFERER);
  u.searchParams.set('h_user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  if (!ts) return u.toString();
  if (kind === 'segment') u.searchParams.set('transform', 'ts');
  else u.searchParams.set('transformer', 'ts_stream');
  return u.toString();
}

// Master généré : /netmirror/master.m3u8?h&id&p&n&d&q=1080p,720p&a=0,1
app.get('/netmirror/master.m3u8', (req, res) => {
  const { h, id, p, n, d } = req.query as Record<string, string>;
  const qualities = String(req.query.q || '').split(',').filter(Boolean);
  const audio = String(req.query.a || '').split(',').filter(x => x !== '');
  if (!h || !id || !p || !qualities.length) return res.status(400).send('paramètres manquants');

  const base = nmSegBase(req);
  const self = (q: string) => {
    const u = new URL('/netmirror/video.m3u8', base);
    u.searchParams.set('h', h); u.searchParams.set('id', id); u.searchParams.set('p', p);
    u.searchParams.set('n', String(n || 0)); u.searchParams.set('d', String(d || 10)); u.searchParams.set('q', q);
    return u.toString();
  };
  // `a` = "index:code:nom" par piste (langues issues du master d'origine).
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  audio.forEach((spec, k) => {
    const [idx, code = 'und', ...rest] = spec.split(':');
    const name = decodeURIComponent(rest.join(':') || code);
    const url = nmProxy(base, `https://${h}/files/${id}/a/${idx}/${idx}.m3u8`, 'manifest');
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="${code}",NAME="${name}",DEFAULT=${k === 0 ? 'YES' : 'NO'},AUTOSELECT=${k === 0 ? 'YES' : 'NO'},URI="${url}"`);
  });
  // Sous-titres : `s` = "code:nom:uriEncodée" (listés par le master, sur subscdn.top).
  const subs = String(req.query.s || '').split(',').filter(Boolean);
  subs.forEach((spec, k) => {
    const [code = 'und', nameEnc = '', uriEnc = ''] = spec.split(':');
    if (!uriEnc) return;
    const name = decodeURIComponent(nameEnc) || code;
    const url = nmProxy(base, decodeURIComponent(uriEnc), 'manifest', false); // pas de transformer TS
    lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${code}",NAME="${name}",DEFAULT=NO,AUTOSELECT=${k === 0 ? 'YES' : 'NO'},FORCED=NO,URI="${url}"`);
  });

  const BW: Record<string, [number, string]> = { '1080p': [3000000, '1920x1080'], '720p': [1500000, '1280x720'], '480p': [800000, '854x480'] };
  for (const q of qualities) {
    const [bw, resn] = BW[q] || [1000000, '1280x720'];
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${resn}${audio.length ? ',AUDIO="aac"' : ''}${subs.length ? ',SUBTITLES="subs"' : ''}`);
    lines.push(self(q));
  }
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(lines.join('\n') + '\n');
});

// Playlist vidéo générée : segments {prefix}_NNN.jpg proxifiés + transform ts.
app.get('/netmirror/video.m3u8', (req, res) => {
  const { h, id, p, q } = req.query as Record<string, string>;
  const n = parseInt(String(req.query.n || '0'), 10);
  const d = parseFloat(String(req.query.d || '10')) || 10;
  if (!h || !id || !p || !q || !n) return res.status(400).send('paramètres manquants');

  const base = nmSegBase(req);
  const target = Math.max(12, Math.ceil(d));
  const out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 0; i < n; i++) {
    out.push(`#EXTINF:${d.toFixed(3)},`);
    out.push(nmProxy(base, `https://${h}/files/${id}/${q}/${p}_${String(i).padStart(3, '0')}.jpg`, 'segment'));
  }
  out.push('#EXT-X-ENDLIST');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(out.join('\n') + '\n');
});

// CinemaOS config admin (reload keys/token/scrapers without a rebuild)
app.get('/api/cinemaos/config', (req, res) => {
  if (req.query.reload === 'true') {
    try { const c = reloadCinemaosConfig(); return res.json({ ok: true, scrapers: c.scrapers.length }); }
    catch (e: any) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  res.json({ ok: true });
});

// Stats endpoint
app.get('/api/stats', (_req, res) => {
  const uptime = Date.now() - stats.startTime;
  const uptimeHours = Math.floor(uptime / 3600000);
  const uptimeMinutes = Math.floor((uptime % 3600000) / 60000);

  res.json({
    uptime: `${uptimeHours}h ${uptimeMinutes}m`,
    uptimeMs: uptime,
    requests: stats.requests,
    sources: stats.sources,
    streamsServed: stats.streamsServed,
    metrics: getAllMetrics(),
    cache: getCacheStats(),
  });
});

// Cache stats standalone
app.get('/api/cache/stats', (_req, res) => {
  res.json(getCacheStats());
});

// Retry a probe request on transient network/TLS errors. Some CDN edge nodes
// intermittently return a TLS internal_error (alert 80) or serve an incomplete
// cert chain (-> "unable to get local issuer certificate"); a single blip must
// not be reported as "down". Retries only on transient errors, not on HTTP status.
async function probeGet(url: string, opts: any, attempts = 3): Promise<any> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios.get(url, opts);
    } catch (e: any) {
      lastErr = e;
      const code = e?.code || '';
      const transient =
        ['EPROTO', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN',
         'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) ||
        /unable to get local issuer certificate|socket hang up|alert|EPROTO/i.test(e?.message || '');
      if (!transient || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Health check endpoint - tests each source
app.get('/api/health', async (_req, res) => {
  const results: Record<string, { status: 'up' | 'down' | 'degraded'; latency?: number; error?: string }> = {};

  // Test NetMirror (tv/p.php returns JSON with "r":"n" when up)
  const netmirrorStart = Date.now();
  try {
    const resp = await axios.post('https://net52.cc/tv/p.php', null, {
      timeout: 10000,
      validateStatus: (s: number) => s < 500,
    });
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    results.netmirror = {
      status: body.includes('"r":"n"') ? 'up' : 'degraded',
      latency: Date.now() - netmirrorStart,
    };
  } catch (e: any) {
    results.netmirror = { status: 'down', error: e.message };
  }

  // Test Movix (hit its current API from hot-reloaded config)
  const movixEndpoints = getMovixEndpoints();
  const movixStart = Date.now();
  try {
    const resp = await probeGet(`${movixEndpoints.api}/api/purstream/movie/550/stream`, {
      timeout: 10000,
      headers: { 'Referer': movixEndpoints.referer },
      validateStatus: (s: number) => s < 500,
    });
    results.movix = {
      status: resp.status === 200 ? 'up' : 'degraded',
      latency: Date.now() - movixStart,
    };
  } catch (e: any) {
    results.movix = { status: 'down', error: e.message };
  }

  // Test StreamFlix
  const streamflixStart = Date.now();
  try {
    const resp = await probeGet('https://api.streamflix.app/config/config-streamflixapp.json', {
      timeout: 10000,
      validateStatus: (s: number) => s < 500,
    });
    results.streamflix = {
      status: resp.status === 200 ? 'up' : 'degraded',
      latency: Date.now() - streamflixStart,
    };
  } catch (e: any) {
    results.streamflix = { status: 'down', error: e.message };
  }

  // Test Faklum (homepage returns token link)
  const faklumStart = Date.now();
  try {
    const resp = await probeGet('https://faklum.com/', {
      timeout: 10000,
      validateStatus: (s: number) => s < 500,
    });
    const hasToken = /<a\s+id=["']faklumc["']\s+href=["'][a-z0-9]+["']/i.test(resp.data);
    results.faklum = {
      status: hasToken ? 'up' : 'degraded',
      latency: Date.now() - faklumStart,
    };
  } catch (e: any) {
    results.faklum = { status: 'down', error: e.message };
  }

  // Test Flemmix (homepage should contain film links)
  const flemmixEndpoints = getFlemmixEndpoints();
  const flemmixStart = Date.now();
  try {
    const resp = await probeGet(flemmixEndpoints.base + '/', {
      timeout: 10000,
      validateStatus: (s: number) => s < 500,
    });
    const hasFilms = /\/film-en-streaming\/\d+-/.test(resp.data);
    results.flemmix = {
      status: hasFilms ? 'up' : 'degraded',
      latency: Date.now() - flemmixStart,
    };
  } catch (e: any) {
    results.flemmix = { status: 'down', error: e.message };
  }

  const allUp = Object.values(results).every(r => r.status === 'up');
  const allDown = Object.values(results).every(r => r.status === 'down');

  res.json({
    overall: allDown ? 'down' : (allUp ? 'healthy' : 'degraded'),
    sources: results,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`LooStream Addon running at http://localhost:${PORT}`);
  console.log(`Install in Stremio: http://localhost:${PORT}/manifest.json`);
  console.log(`Proxy mode: ${DEFAULT_USE_LOCAL_PROXY ? 'LOCAL' : 'MEDIAFLOW (configurable)'}`);
});

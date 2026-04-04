import express from 'express';
import axios from 'axios';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { getStreams, getStreamUrl } from './scrapers/netmirror';
import { getStreamFlixStreams } from './scrapers/streamflix';
import { getMovixStreams } from './scrapers/movix';
import proxyRouter, { isAllowedUrl } from './proxy';

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
  };
  streamsServed: {
    movix: number;
    netmirror: number;
    streamflix: number;
  };
}

const stats: Stats = {
  startTime: Date.now(),
  requests: { total: 0, streams: 0, proxy: 0 },
  sources: {
    movix: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    netmirror: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    streamflix: { requests: 0, success: 0, errors: 0, lastSuccess: null },
  },
  streamsServed: { movix: 0, netmirror: 0, streamflix: 0 },
};

function trackSourceResult(source: 'movix' | 'netmirror' | 'streamflix', success: boolean, streamCount: number = 0) {
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
  behaviorHints: { notWebReady: boolean; bingeGroup: string };
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
  config?: UserConfig | null
): string | null {
  // SECURITY: Validate stream URL before proxying (applies to both local and MediaFlow)
  const validation = isAllowedUrl(streamUrl);
  if (!validation.allowed) {
    console.warn(`[BuildProxy] Blocked URL: ${validation.reason} - ${streamUrl}`);
    return null; // Return null for blocked URLs
  }

  const useLocal = config ? config.proxy === 'local' : DEFAULT_USE_LOCAL_PROXY;
  const mfUrl = config?.mfUrl || DEFAULT_MEDIAFLOW_URL;
  const mfPass = config?.mfPass || DEFAULT_MEDIAFLOW_PASSWORD;

  if (useLocal && req) {
    // Use local proxy
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    // Choose endpoint based on stream type
    const endpoint = isHlsUrl(streamUrl) ? '/proxy/manifest' : '/proxy/stream';
    const proxyUrl = new URL(endpoint, baseUrl);
    proxyUrl.searchParams.set('url', streamUrl);

    if (useTransformer) {
      proxyUrl.searchParams.set('transformer', 'ts_stream');
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

    const proxyUrl = new URL('/proxy/hls/manifest.m3u8', mfUrl);
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

async function getTmdbInfo(type: string, id: string, config?: UserConfig | null): Promise<{ title: string; year: string; tmdbId: string } | null> {
  const tmdbKey = config?.tmdbKey || DEFAULT_TMDB_KEY;

  if (!tmdbKey) {
    console.error('[TMDB] No API key configured!');
    return null;
  }

  try {
    let tmdbId = id;

    // Convert IMDB ID to TMDB ID if needed
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

    return { title, year, tmdbId };
  } catch (e) {
    console.error('[TMDB] Error:', e);
    return null;
  }
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

    const [netmirrorResults, streamflixResults, movixResults] = await Promise.all([
      getStreams(info.title, info.year, parsed.season, parsed.episode)
        .then(r => { trackSourceResult('netmirror', true, r.length); return r; })
        .catch(e => { console.log('[NetMirror] Error:', e); trackSourceResult('netmirror', false); return []; }),
      getStreamFlixStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, config?.tmdbKey || DEFAULT_TMDB_KEY)
        .then(r => { trackSourceResult('streamflix', true, r.length); return r; })
        .catch(e => { console.log('[StreamFlix] Error:', e); trackSourceResult('streamflix', false); return []; }),
      getMovixStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode)
        .then(r => { trackSourceResult('movix', true, r.length); return r; })
        .catch(e => { console.log('[Movix] Error:', e); trackSourceResult('movix', false); return []; }),
    ]);

    const streams: StreamWithMeta[] = [];

    // Process Movix results
    for (const mv of movixResults) {
      const proxiedUrl = buildProxyUrl(mv.url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, false, req, config);

      if (!proxiedUrl) continue; // Skip blocked URLs

      streams.push({
        name: `Movix\n${mv.language}`,
        title: `${mv.language} [${mv.quality}]`,
        url: proxiedUrl,
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

    // Process NetMirror results
    const transformerCache = new Map<string, boolean>();

    for (const r of netmirrorResults) {
      const hlsUrl = await getStreamUrl(
        r.platform as 'netflix' | 'primevideo' | 'disney',
        r.contentId,
        r.quality
      );

      if (!hlsUrl) continue;

      const contentKey = `${r.platform}:${r.contentId}`;
      let useTransformer = transformerCache.get(contentKey);
      if (useTransformer === undefined) {
        useTransformer = await needsTransformer(hlsUrl);
        transformerCache.set(contentKey, useTransformer);
        console.log(`[Stream] ${r.platform} needs transformer: ${useTransformer}`);
      }

      const proxiedUrl = buildProxyUrl(hlsUrl, {
        'Referer': 'https://net52.cc/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, useTransformer, req, config);

      if (!proxiedUrl) continue; // Skip blocked URLs

      streams.push({
        name: `NetMirror\n${r.quality}`,
        title: `${r.title} [${r.quality}]`,
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: `netmirror-${r.platform}`,
        },
        _meta: {
          quality: r.quality,
          language: 'Original',
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

    if (streams.length === 0) {
      console.log('[Stream] No streams found');
      return res.json({ streams: [] });
    }

    // Apply user preferences (filter + sort)
    const sortedStreams = filterAndSortStreams(streams, config);

    // Remove _meta before sending to Stremio (internal use only)
    const cleanStreams = sortedStreams.map(({ _meta, ...rest }) => rest);

    console.log(`[Stream] Returning ${cleanStreams.length} streams (Movix: ${movixResults.length}, NetMirror: ${netmirrorResults.length}, StreamFlix: ${streamflixResults.length})`);
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

// Play endpoint - generates fresh URL and proxies with headers
app.get('/play/:platform/:contentId/:quality', async (req, res) => {
  const { platform, contentId, quality } = req.params;
  console.log(`[Play] Generating fresh URL for ${platform}/${contentId}/${quality}`);

  try {
    const url = await getStreamUrl(
      platform as 'netflix' | 'primevideo' | 'disney',
      contentId,
      quality
    );

    if (!url) {
      console.log('[Play] Failed to get stream URL');
      return res.status(503).send('Stream not available');
    }

    console.log(`[Play] Proxying ${url}`);

    // Proxy the request with required headers
    const response = await axios.get(url, {
      headers: {
        'Referer': 'https://net52.cc/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      responseType: 'stream',
    });

    // Forward headers
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe the stream
    response.data.pipe(res);
  } catch (e) {
    console.error('[Play] Error:', e);
    res.status(500).send('Internal error');
  }
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
// ADMIN API (for Telegram bot)
// ============================================

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
  });
});

// Health check endpoint - tests each source
app.get('/api/health', async (_req, res) => {
  const results: Record<string, { status: 'up' | 'down' | 'degraded'; latency?: number; error?: string }> = {};

  // Test NetMirror
  const netmirrorStart = Date.now();
  try {
    const resp = await axios.get('https://net52.cc/', { timeout: 10000 });
    results.netmirror = {
      status: resp.status === 200 ? 'up' : 'degraded',
      latency: Date.now() - netmirrorStart,
    };
  } catch (e: any) {
    results.netmirror = { status: 'down', error: e.message };
  }

  // Test Movix (via one of its APIs)
  const movixStart = Date.now();
  try {
    const resp = await axios.get('https://purstream.store/', { timeout: 10000 });
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
    const resp = await axios.get('https://api.streamflix.one/', { timeout: 10000 });
    results.streamflix = {
      status: resp.status === 200 ? 'up' : 'degraded',
      latency: Date.now() - streamflixStart,
    };
  } catch (e: any) {
    results.streamflix = { status: 'down', error: e.message };
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

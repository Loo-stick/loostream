import express from 'express';
import axios from 'axios';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { getStreams, getStreamUrl } from './scrapers/netmirror';
import { getStreamFlixStreams } from './scrapers/streamflix';
import { getMovixStreams } from './scrapers/movix';
import proxyRouter from './proxy';

const app = express();

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

    // Sanitize strings
    return {
      proxy: parsed.proxy,
      mfUrl: parsed.mfUrl ? sanitizeString(parsed.mfUrl, 500) : undefined,
      mfPass: parsed.mfPass ? sanitizeString(parsed.mfPass, 100) : undefined,
      tmdbKey: parsed.tmdbKey ? sanitizeString(parsed.tmdbKey, 64) : undefined,
    };
  } catch {
    return null;
  }
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
): string {
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

    // Fetch from all sources in parallel
    const [netmirrorResults, streamflixResults, movixResults] = await Promise.all([
      getStreams(info.title, info.year, parsed.season, parsed.episode),
      getStreamFlixStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode)
        .catch(e => { console.log('[StreamFlix] Error:', e); return []; }),
      getMovixStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode)
        .catch(e => { console.log('[Movix] Error:', e); return []; }),
    ]);

    const streams: Array<{
      name: string;
      title: string;
      url: string;
      behaviorHints: { notWebReady: boolean; bingeGroup: string };
    }> = [];

    // Process Movix results FIRST (VF/VOSTFR - priorité française)
    for (const mv of movixResults) {
      const proxiedUrl = buildProxyUrl(mv.url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, false, req, config);

      streams.push({
        name: `Movix\n${mv.language}`,
        title: `${mv.language} [${mv.quality}]`,
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: 'movix',
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

      streams.push({
        name: `NetMirror\n${r.quality}`,
        title: `${r.title} [${r.quality}]`,
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: `netmirror-${r.platform}`,
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

      streams.push({
        name: `StreamFlix\n${sf.quality}`,
        title: `${sf.language} [${sf.quality}]`,
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: 'streamflix',
        },
      });
    }

    if (streams.length === 0) {
      console.log('[Stream] No streams found');
      return res.json({ streams: [] });
    }

    console.log(`[Stream] Returning ${streams.length} streams (Movix: ${movixResults.length}, NetMirror: ${netmirrorResults.length}, StreamFlix: ${streamflixResults.length})`);
    res.json({ streams });
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

// Health check
app.get('/', (_req, res) => {
  res.redirect('/manifest.json');
});

app.listen(PORT, () => {
  console.log(`LooStream Addon running at http://localhost:${PORT}`);
  console.log(`Install in Stremio: http://localhost:${PORT}/manifest.json`);
  console.log(`Proxy mode: ${DEFAULT_USE_LOCAL_PROXY ? 'LOCAL' : 'MEDIAFLOW (configurable)'}`);
});

import express from 'express';
import axios from 'axios';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { getNetmirrorStreams } from './scrapers/netmirror';
import { getWiflixStreams } from './scrapers/wiflix';
import { getVoirDramaStreams, reloadVoirDramaEndpoints, getVoirDramaEndpoints } from './scrapers/voirdrama';
import { getMovieboxStreams, movieboxProbe, resolveMovieboxUrl, resolveMovieboxSubtitle } from './scrapers/moviebox';
import { getVoirAnimeStreams, getVoirAnimeEndpoints, reloadVoirAnimeEndpoints } from './scrapers/voiranime';
import { getNabistreamStreams, getNabistreamEndpoints, reloadNabistreamEndpoints } from './scrapers/nabistream';
import { getCoflixStreams, getCoflixEndpoints, reloadCoflixEndpoints } from './scrapers/coflix';
import { getStreamFlixStreams, reloadStreamflixEndpoints, getStreamflixEndpoints } from './scrapers/streamflix';
import { getMovixStreams, reloadMovixEndpoints, getMovixEndpoints } from './scrapers/movix';
import { getFrenchStreamStreams, reloadFrenchStreamEndpoints, getFrenchStreamEndpoints } from './scrapers/frenchstream';
import { cached, getCacheStats } from './cache';
import { recordOutcome, getAllMetrics } from './metrics';
import crypto from 'crypto';
import proxyRouter, { isAllowedUrl, addAllowedDomain, getAllowedDomains, AUTO_WHITELIST } from './proxy';
import { accessEnabled, keyMatches, signUrl, requireQueryKey } from './access';
import * as fsSync from 'fs';
import { ExtractorConfig, reloadExtractorDomains, getExtractorDomains } from './extractors';
import { getSceneMeta, buildFilename, providerLabel } from './filename';
import { buildStreamName, buildStreamTitle } from './display';

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
    frenchstream: { requests: number; success: number; errors: number; lastSuccess: number | null };
    wiflix: { requests: number; success: number; errors: number; lastSuccess: number | null };
    voirdrama: { requests: number; success: number; errors: number; lastSuccess: number | null };
    moviebox: { requests: number; success: number; errors: number; lastSuccess: number | null };
    voiranime: { requests: number; success: number; errors: number; lastSuccess: number | null };
    nabistream: { requests: number; success: number; errors: number; lastSuccess: number | null };
    coflix: { requests: number; success: number; errors: number; lastSuccess: number | null };
  };
  streamsServed: {
    movix: number;
    netmirror: number;
    streamflix: number;
    frenchstream: number;
    wiflix: number;
    voirdrama: number;
    moviebox: number;
    voiranime: number;
    nabistream: number;
    coflix: number;
  };
}

const stats: Stats = {
  startTime: Date.now(),
  requests: { total: 0, streams: 0, proxy: 0 },
  sources: {
    movix: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    netmirror: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    streamflix: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    frenchstream: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    wiflix: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    voirdrama: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    moviebox: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    voiranime: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    nabistream: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    coflix: { requests: 0, success: 0, errors: 0, lastSuccess: null },
  },
  streamsServed: { movix: 0, netmirror: 0, streamflix: 0, frenchstream: 0, wiflix: 0, voirdrama: 0, moviebox: 0, voiranime: 0, nabistream: 0, coflix: 0 },
};

function trackSourceResult(source: 'movix' | 'netmirror' | 'streamflix' | 'frenchstream' | 'wiflix' | 'voirdrama' | 'moviebox' | 'voiranime' | 'nabistream' | 'coflix', success: boolean, streamCount: number = 0) {
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
  proxy: 'local' | 'mediaflow' | 'direct';
  mfUrl?: string;
  mfPass?: string;
  tmdbKey?: string;
  accessKey?: string;    // clé d'accès (si l'hébergeur a activé ACCESS_KEY)
  prefQuality?: string;  // "1080p", "4K", "720p", "480p"
  langOrder?: string[];  // ["MULTI", "VF", "VOSTFR", "VO"]
  minStreams?: number;   // early exit: stop waiting once this many wanted streams are in (0 = wait for all)
}

// Stream with metadata for filtering/sorting
interface StreamWithMeta {
  name: string;
  title: string;
  url: string;
  behaviorHints: { notWebReady: boolean; bingeGroup: string; filename?: string; videoSize?: number; proxyHeaders?: { request: Record<string, string> } };
  subtitles?: { id: string; url: string; lang: string }[];
  _meta: {
    quality: string;
    language: string;
    source: string;
    codec?: string;
    server?: string;
    platform?: string;
    sizeBytes?: number;
    subCount?: number;
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
    if (!['local', 'mediaflow', 'direct'].includes(parsed.proxy)) {
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

    // 0 disables the early exit (wait for every source); cap it so a bogus value
    // can't turn the fan-out into an unbounded wait.
    let minStreams = Number(parsed.minStreams);
    if (!Number.isFinite(minStreams) || minStreams < 0) minStreams = DEFAULT_MIN_STREAMS;
    minStreams = Math.min(Math.round(minStreams), 30);

    // Sanitize strings
    return {
      proxy: parsed.proxy,
      mfUrl: parsed.mfUrl ? sanitizeString(parsed.mfUrl, 500) : undefined,
      mfPass: parsed.mfPass ? sanitizeString(parsed.mfPass, 100) : undefined,
      tmdbKey: parsed.tmdbKey ? sanitizeString(parsed.tmdbKey, 64) : undefined,
      accessKey: parsed.accessKey ? sanitizeString(parsed.accessKey, 128) : undefined,
      prefQuality,
      langOrder,
      minStreams,
    };
  } catch {
    return null;
  }
}

// Garde des routes /:config/* : si ACCESS_KEY est active et que le config ne
// porte pas la bonne clé, répond 401 et renvoie true (l'appelant doit `return`).
function denyIfNoAccess(config: UserConfig | null, res: express.Response): boolean {
  if (accessEnabled() && !keyMatches(config?.accessKey)) {
    res.status(401).send("Non autorisé : clé d'accès requise ou invalide");
    return true;
  }
  return false;
}

// ============================================
// STREAM FILTERING AND SORTING
// ============================================
const DEFAULT_LANG_ORDER = ['MULTI', 'VF', 'VOSTFR', 'VO'];

// ============================================
// SOURCE FAN-OUT WITH EARLY EXIT
// ============================================
// Sources are queried in parallel, but the response used to wait for the very
// last one — so a single slow source set the response time for everybody.
// Instead we answer as soon as we hold enough streams in the languages the user
// actually asked for. Sources still in flight are NOT cancelled: they keep
// running and fill the cache, so the next request for the same title gets them
// instantly.
const DEFAULT_MIN_STREAMS = 5;
const EARLY_EXIT_GRACE_MS = 2000;   // never answer before this — lets near-tied sources land
const EARLY_EXIT_DEADLINE_MS = 20000; // hard ceiling, even if the target is never met

interface SourceTask<T> {
  name: string;
  promise: Promise<T[]>;
  /** How many of these results match the user's language preference. */
  countWanted: (results: T[]) => number;
}

/**
 * Resolves to one result array per task, in order. A task that hasn't settled
 * when we stop waiting yields an empty array.
 */
function collectSources(
  tasks: SourceTask<any>[],
  minStreams: number,
  onDone: (reason: string, elapsedMs: number) => void
): Promise<any[][]> {
  const results: any[][] = tasks.map(() => []);
  // minStreams === 0 means the user opted out of the early exit.
  if (minStreams <= 0) {
    return Promise.all(tasks.map(t => t.promise)).then(all => {
      onDone('toutes les sources', 0);
      return all;
    });
  }

  return new Promise<any[][]>(resolve => {
    const started = Date.now();
    let pending = tasks.length;
    let wanted = 0;
    let settled = false;

    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(deadlineTimer);
      onDone(reason, Date.now() - started);
      // Shallow copy: each slot is replaced wholesale, so this is a true snapshot
      // even though late tasks keep writing into `results`.
      resolve(results.slice());
    };

    const check = () => {
      if (settled) return;
      if (pending === 0) return finish('toutes les sources');
      if (wanted >= minStreams && Date.now() - started >= EARLY_EXIT_GRACE_MS) {
        finish(`early exit (${wanted} streams voulus)`);
      }
    };

    tasks.forEach((task, i) => {
      task.promise
        .then(r => {
          results[i] = r;
          wanted += task.countWanted(r);
        })
        .catch(() => { /* per-source catch already returns [] upstream */ })
        .then(() => { pending--; check(); });
    });

    const graceTimer = setTimeout(check, EARLY_EXIT_GRACE_MS);
    const deadlineTimer = setTimeout(() => finish('deadline atteinte'), EARLY_EXIT_DEADLINE_MS);
  });
}

/**
 * Would this stream survive the user's filters? Single source of truth, used
 * both to decide when we have "enough" streams (early exit) and to do the final
 * filtering — if the two ever disagreed we'd exit early on streams that then
 * get dropped, and return fewer than the user asked for.
 *
 * Any accepted language and any accepted quality counts: 3 VF + 2 VOSTFR is
 * five results, and so is 3×1080p + 2×720p.
 */
function passesPreferences(
  meta: { quality: string; language: string; source: string },
  langOrder: string[],
  prefQualityScore: number
): boolean {
  // NetMirror ships multi-language HLS — exempt, as it always has been.
  if (meta.source === 'netmirror') return true;
  if (!langOrder.includes(normalizeLanguage(meta.language))) return false;
  const streamQualityScore = QUALITY_SCORES[normalizeQuality(meta.quality)] || 2;
  return streamQualityScore >= prefQualityScore - 1; // one step lower is still fine
}

/** Counts a source's results that pass the user's language AND quality prefs. */
function wantedCounter(source: string, langOrder: string[], prefQualityScore: number) {
  return (results: { language?: string; quality?: string }[]) =>
    results.filter(r =>
      passesPreferences(
        { quality: r.quality || '', language: r.language || '', source },
        langOrder,
        prefQualityScore
      )
    ).length;
}
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

  // Filter streams based on preferences (same predicate the early exit counts with)
  let filtered = streams.filter(s => passesPreferences(s._meta, langOrder, prefQualityScore));

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
  // AUTO_WHITELIST (côté serveur, sûr) : ce domaine sort de NOTRE pipeline
  // d'extraction (pas d'une requête client), on l'apprend AVANT le contrôle
  // d'allowlist pour qu'un nouveau CDN de source passe sans intervention. Le
  // blocage des IP privées (dans isAllowedUrl) reste la garde SSRF.
  if (AUTO_WHITELIST) {
    try { addAllowedDomain(new URL(streamUrl).hostname); } catch { /* url invalide -> isAllowedUrl tranche */ }
  }

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

    return signUrl(proxyUrl).toString();
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

// Clé d'accès : les endpoints de flux auto-générés (appelés directement par le
// player, hors chaîne /:config) exigent `?k=` quand ACCESS_KEY est active.
// (Le proxy gère sa propre garde en interne pour épargner /proxy/domains au bot.)
app.use(['/netmirror', '/moviebox', '/nabistream'], requireQueryKey);

// Manifest generator
function getManifest(req: express.Request) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const baseUrl = `${proto}://${host}`;

  return {
    id: 'community.loostream.stremio',
    version: '1.10.0',
    name: 'LooStream',
    logo: `${baseUrl}/logo.png`,
    description: 'Netflix, Prime, Disney+ mirrors + StreamFlix + Movix VF/VOSTFR',
    resources: ['stream', 'subtitles'],
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
  // Sans config, aucune clé possible : refusé si la protection est active.
  if (accessEnabled()) return res.status(401).send("Non autorisé : clé d'accès requise");
  res.json(getManifest(req));
});

// Manifest with config
app.get('/:config/manifest.json', (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config) {
    return res.status(400).json({ error: 'Invalid configuration' });
  }
  if (denyIfNoAccess(config, res)) return;
  res.json(getManifest(req));
});

// TMDB API helper
const DEFAULT_TMDB_KEY = process.env.TMDB_API_KEY || '';

const TMDB_TTL_MS = 12 * 60 * 60 * 1000;

async function getTmdbInfo(type: string, id: string, config?: UserConfig | null): Promise<{ title: string; originalTitle: string; frenchTitle: string; year: string; tmdbId: string; imdbId: string; originalLanguage: string } | null> {
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
        // Détails EN + FR en parallèle : les sites FR indexent par titre français,
        // mais on ne veut pas payer un aller-retour TMDB séquentiel de plus.
        const [resp, frResp] = await Promise.all([
          axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${tmdbKey}`),
          axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${tmdbKey}&language=fr-FR`).catch(() => null),
        ]);

        const title = resp.data.title || resp.data.name;
        // Original (romaji) title — anime often lives under it on FR sites
        // (jigokuraku, shingeki-no-kyojin) rather than the English title.
        const originalTitle = resp.data.original_title || resp.data.original_name || '';
        const year = (resp.data.release_date || resp.data.first_air_date || '').split('-')[0];

        let imdbId = id.startsWith('tt') ? id : (resp.data.imdb_id || '');
        if (!imdbId) {
          try {
            const ext = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${tmdbKey}`);
            imdbId = ext.data?.imdb_id || '';
          } catch { /* imdbId optional */ }
        }

        const originalLanguage = String(resp.data.original_language || '').toLowerCase();

        // Titre FR (récupéré en parallèle plus haut) : les sites FR indexent
        // par le titre français, pas l'anglais/original.
        const frenchTitle = frResp?.data?.title || frResp?.data?.name || '';

        return { title, originalTitle, frenchTitle, year, tmdbId, imdbId, originalLanguage };
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

    const langOrder = config?.langOrder || DEFAULT_LANG_ORDER;
    const prefQualityScore = QUALITY_SCORES[config?.prefQuality || '1080p'] || 3;
    const minStreams = config?.minStreams ?? DEFAULT_MIN_STREAMS;

    const sourcePromises = [
      getNetmirrorStreams(info.title, info.year, type as 'movie' | 'series', parsed.season, parsed.episode, info.originalLanguage)
        .then(r => { trackSourceResult('netmirror', true, r.length); recordOutcome('netmirror', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[NetMirror] Error:', e); trackSourceResult('netmirror', false); recordOutcome('netmirror', 'error', e?.message); return []; }),
      getStreamFlixStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, config?.tmdbKey || DEFAULT_TMDB_KEY)
        .then(r => { trackSourceResult('streamflix', true, r.length); recordOutcome('streamflix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[StreamFlix] Error:', e); trackSourceResult('streamflix', false); recordOutcome('streamflix', 'error', e?.message); return []; }),
      getMovixStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, extractorConfig)
        .then(r => { trackSourceResult('movix', true, r.length); recordOutcome('movix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Movix] Error:', e); trackSourceResult('movix', false); recordOutcome('movix', 'error', e?.message); return []; }),
      getFrenchStreamStreams(info.tmdbId, type as 'movie' | 'series', extractorConfig, config?.tmdbKey || DEFAULT_TMDB_KEY, parsed.season, parsed.episode)
        .then(r => { trackSourceResult('frenchstream', true, r.length); recordOutcome('frenchstream', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[FrenchStream] Error:', e); trackSourceResult('frenchstream', false); recordOutcome('frenchstream', 'error', e?.message); return []; }),
      getWiflixStreams(info.tmdbId, type as 'movie' | 'series', extractorConfig, parsed.season, parsed.episode)
        .then(r => { trackSourceResult('wiflix', true, r.length); recordOutcome('wiflix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Wiflix] Error:', e); trackSourceResult('wiflix', false); recordOutcome('wiflix', 'error', e?.message); return []; }),
      getVoirDramaStreams(info.tmdbId, type as 'movie' | 'series', extractorConfig, parsed.season, parsed.episode, info.title)
        .then(r => { trackSourceResult('voirdrama', true, r.length); recordOutcome('voirdrama', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[VoirDrama] Error:', e); trackSourceResult('voirdrama', false); recordOutcome('voirdrama', 'error', e?.message); return []; }),
      getMovieboxStreams(info.tmdbId, type as 'movie' | 'series', info.title, info.year, parsed.season, parsed.episode)
        .then(r => { trackSourceResult('moviebox', true, r.length); recordOutcome('moviebox', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[MovieBox] Error:', e); trackSourceResult('moviebox', false); recordOutcome('moviebox', 'error', e?.message); return []; }),
      // VoirAnime : uniquement pour l'anime (originalLanguage japonais) — évite de
      // scraper voir-anime.to pour chaque film/série occidental.
      (info.originalLanguage === 'ja'
        ? getVoirAnimeStreams(parsed.baseId, type as 'movie' | 'series', extractorConfig, parsed.season, parsed.episode, info.title, info.originalTitle)
        : Promise.resolve([]))
        .then(r => { if (info.originalLanguage === 'ja') { trackSourceResult('voiranime', true, r.length); recordOutcome('voiranime', r.length > 0 ? 'success' : 'empty'); } return r; })
        .catch(e => { console.log('[VoirAnime] Error:', e); trackSourceResult('voiranime', false); recordOutcome('voiranime', 'error', e?.message); return []; }),
      // Nabistream : dramas coréens/asiatiques VOSTFR (API keyée TMDB). Non gaté —
      // une seule requête API, renvoie [] hors catalogue.
      getNabistreamStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode)
        .then(r => { trackSourceResult('nabistream', true, r.length); recordOutcome('nabistream', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Nabistream] Error:', e); trackSourceResult('nabistream', false); recordOutcome('nabistream', 'error', e?.message); return []; }),
      // Coflix : films/séries FR généralistes, VF ET VOSTFR (scraping titre-keyé).
      // Site FR -> chercher d'abord le titre FRANÇAIS, puis l'anglais en repli.
      getCoflixStreams(type as 'movie' | 'series', extractorConfig, parsed.season, parsed.episode, info.frenchTitle || info.title, info.title)
        .then(r => { trackSourceResult('coflix', true, r.length); recordOutcome('coflix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Coflix] Error:', e); trackSourceResult('coflix', false); recordOutcome('coflix', 'error', e?.message); return []; }),
    ];

    const SOURCE_NAMES = ['netmirror', 'streamflix', 'movix', 'frenchstream', 'wiflix', 'voirdrama', 'moviebox', 'voiranime', 'nabistream', 'coflix'];
    const collected = await collectSources(
      sourcePromises.map((promise, i) => ({
        name: SOURCE_NAMES[i],
        promise,
        countWanted: wantedCounter(SOURCE_NAMES[i], langOrder, prefQualityScore),
      })),
      minStreams,
      (reason, ms) => console.log(`[Stream] Fan-out terminé: ${reason}${ms ? ` en ${(ms / 1000).toFixed(2)}s` : ''}`)
    );

    // collectSources is order-preserving but untyped (heterogeneous tuple), so
    // restore each source's real element type here.
    const netmirrorResults = collected[0] as Awaited<ReturnType<typeof getNetmirrorStreams>>;
    const streamflixResults = collected[1] as Awaited<ReturnType<typeof getStreamFlixStreams>>;
    const movixResults = collected[2] as Awaited<ReturnType<typeof getMovixStreams>>;
    const frenchstreamResults = collected[3] as Awaited<ReturnType<typeof getFrenchStreamStreams>>;
    const wiflixResults = collected[4] as Awaited<ReturnType<typeof getWiflixStreams>>;
    const voirdramaResults = collected[5] as Awaited<ReturnType<typeof getVoirDramaStreams>>;
    const movieboxResults = collected[6] as Awaited<ReturnType<typeof getMovieboxStreams>>;
    const voiranimeResults = collected[7] as Awaited<ReturnType<typeof getVoirAnimeStreams>>;
    const nabistreamResults = collected[8] as Awaited<ReturnType<typeof getNabistreamStreams>>;
    const coflixResults = collected[9] as Awaited<ReturnType<typeof getCoflixStreams>>;

    // On accumule des "drafts" (streams sans name/title). name/title sont posés
    // en UNE passe centralisée plus bas (src/display.ts), pour un rendu uniforme.
    type StreamDraft = Omit<StreamWithMeta, 'name' | 'title'>;
    const drafts: StreamDraft[] = [];

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
        // Purstream masters live at .../watch/hls/master?u=… — no .m3u8 extension,
        // so URL sniffing routes them to the passthrough proxy, which does NOT
        // rewrite the manifest. Their subtitle URIs are relative ("sub?u=…"), so
        // the player resolves them against the proxy host and gets a 404: the
        // stream plays but every subtitle track is silently missing. The API
        // already tells us the format — trust it over the extension.
        const isHls = mv.format === 'm3u8';
        const proxiedUrl = buildProxyUrl(mv.url, proxyHeaders, false, req, config, false, isHls);

        if (!proxiedUrl) continue; // Skip blocked URLs
        finalUrl = proxiedUrl;
      }

      drafts.push({
        url: finalUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: 'movix',
        },
        _meta: {
          quality: mv.quality,
          language: mv.language,
          source: 'movix',
          server: mv.server,
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
      const proxiedUrl = signUrl(mu).toString(); // &k= si ACCESS_KEY active

      drafts.push({
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: `netmirror-${r.platform}`,
        },
        _meta: {
          quality: r.quality,
          language: r.language,
          source: 'netmirror',
          platform: r.platform,
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

      drafts.push({
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

    // Process Wiflix results (API Movix, tmdbId-keyed — pas de scraping).
    for (const wf of wiflixResults) {
      const proxiedUrl = buildProxyUrl(wf.url, {
        ...(wf.headers || {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, false, req, config);

      if (!proxiedUrl) continue; // Skip blocked URLs

      drafts.push({
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: `wiflix-${wf.server}`,
        },
        _meta: {
          quality: wf.quality,
          language: wf.language,
          source: 'wiflix',
          server: wf.server,
        },
      });
    }

    // Process VoirDrama results (dramas asiatiques, API Movix, séries seulement).
    for (const vd of voirdramaResults) {
      const proxiedUrl = buildProxyUrl(vd.url, {
        ...(vd.headers || {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, false, req, config);

      if (!proxiedUrl) continue; // Skip blocked URLs

      drafts.push({
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: `voirdrama-${vd.server}`,
        },
        _meta: {
          quality: vd.quality,
          language: vd.language,
          source: 'voirdrama',
          server: vd.server,
        },
      });
    }

    // Process VoirAnime results (anime VF/VOSTFR, scraping voir-anime.to).
    for (const va of voiranimeResults) {
      const proxiedUrl = buildProxyUrl(va.url, {
        ...(va.headers || {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, false, req, config);

      if (!proxiedUrl) continue; // Skip blocked URLs

      drafts.push({
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: `voiranime-${va.server}`,
        },
        _meta: {
          quality: va.quality,
          language: va.language,
          source: 'voiranime',
          server: va.server,
        },
      });
    }

    // Process Nabistream results (dramas asiatiques VOSTFR — HLS master direct).
    // Les sous-titres NE sont PAS attachés au stream : ils sont servis via la
    // ressource /subtitles (handleSubtitles), seul mécanisme que Nuvio consomme.
    // Un double-listage (stream + ressource) faisait empiler les pistes.
    for (const nb of nabistreamResults) {
      const proxiedUrl = buildProxyUrl(nb.url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, false, req, config, false, true);

      if (!proxiedUrl) continue; // Skip blocked URLs

      drafts.push({
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: 'nabistream',
        },
        _meta: {
          quality: nb.quality,
          language: nb.language,
          source: 'nabistream',
          subCount: nb.subtitles.length,
        },
      });
    }

    // Process Coflix results (films/séries FR VF+VOSTFR, HLS extrait des hôtes).
    for (const cf of coflixResults) {
      const proxiedUrl = buildProxyUrl(cf.url, {
        ...(cf.headers || {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, false, req, config, false, true);

      if (!proxiedUrl) continue; // Skip blocked URLs

      drafts.push({
        url: proxiedUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: `coflix-${cf.server}`,
        },
        _meta: {
          quality: cf.quality,
          language: cf.language,
          source: 'coflix',
          server: cf.server,
        },
      });
    }

    // Process MovieBox results (aoneroom mobile API — direct signed MP4s). The
    // signed URL is time-limited, so instead of embedding it we point at our own
    // /moviebox/stream endpoint which resolves a fresh URL and 302-redirects at
    // play time. Direct MP4 → no proxy bandwidth, always fresh.
    {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const baseUrl = `${proto}://${host}`;
      for (const mb of movieboxResults) {
        const u = new URL('/moviebox/stream', baseUrl);
        u.searchParams.set('sid', mb.subjectId);
        u.searchParams.set('se', String(mb.se));
        u.searchParams.set('ep', String(mb.ep));
        u.searchParams.set('rid', mb.resourceId);
        drafts.push({
          url: signUrl(u).toString(), // &k= si ACCESS_KEY active
          behaviorHints: {
            notWebReady: false,
            bingeGroup: `moviebox-${mb.quality}`,
            ...(mb.sizeBytes ? { videoSize: mb.sizeBytes } : {}),
          },
          // Sous-titres servis via la ressource /subtitles (handleSubtitles), pas
          // au niveau du stream — évite le double-listage dans Nuvio.
          _meta: {
            quality: mb.quality,
            language: mb.language,
            source: 'moviebox',
            codec: mb.codec,
            sizeBytes: mb.sizeBytes,
            subCount: (mb.subLangs || []).length,
          },
        });
      }
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

      drafts.push({
        url: finalUrl,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: 'frenchstream',
        },
        _meta: {
          quality: fr.quality,
          language: fr.language,
          source: 'frenchstream',
          server: fr.server,
        },
      });
    }

    if (drafts.length === 0) {
      console.log('[Stream] No streams found');
      return res.json({ streams: [] });
    }

    // Nom de fichier scène (AIOStreams parse title/year/S-E/resolution/lang).
    // Titre depuis Cinemeta (anglais/scène) plutôt que le site source (souvent
    // FR/traduit). Calculé AVANT la passe d'affichage pour l'afficher aussi
    // (ligne 💾) dans Stremio direct.
    const sceneMeta = await getSceneMeta(
      type === 'series' ? 'series' : 'movie',
      parsed.baseId,
      { title: info.title, year: info.year }
    );

    // Passe centralisée : filename (AIOStreams) + name/title enrichis depuis
    // _meta (src/display.ts). originalLanguage résout le cas "VO" (drapeau).
    const streams: StreamWithMeta[] = drafts.map(d => {
      const filename = buildFilename({
        title: sceneMeta.title,
        year: sceneMeta.year,
        isSeries: type === 'series',
        season: parsed.season,
        episode: parsed.episode,
        lang: d._meta.language,
        originalLanguage: info.originalLanguage,
        resolution: d._meta.quality,
        codec: d._meta.codec,
        provider: providerLabel(d._meta.source),
      });
      return {
        ...d,
        behaviorHints: { ...d.behaviorHints, filename },
        name: buildStreamName(d._meta),
        title: buildStreamTitle(d._meta, info.originalLanguage, filename),
      };
    });

    // Apply user preferences (filter + sort)
    const sortedStreams = filterAndSortStreams(streams, config);

    // Remove _meta before sending to Stremio (internal use only)
    const cleanStreams = sortedStreams.map(({ _meta, ...rest }) => rest);

    // Count actual streams by source (after filtering blocked URLs)
    const movixCount = streams.filter(s => s._meta?.source === 'movix').length;
    const netmirrorCount = streams.filter(s => s._meta?.source === 'netmirror').length;
    const streamflixCount = streams.filter(s => s._meta?.source === 'streamflix').length;

    console.log(`[Stream] Returning ${cleanStreams.length} streams (Movix: ${movixCount}, NetMirror: ${netmirrorCount}, StreamFlix: ${streamflixCount})`);
    res.json({ streams: cleanStreams });
  } catch (e) {
    console.error('[Stream] Error:', e);
    res.json({ streams: [] });
  }
}

// Stream endpoint (without config - uses env defaults)
app.get('/stream/:type/:id.json', async (req, res) => {
  if (accessEnabled()) return res.status(401).send("Non autorisé : clé d'accès requise");
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
  if (denyIfNoAccess(userConfig, res)) return;
  await handleStream(req, res, type, id, userConfig);
});

// Subtitles resource — mécanisme canonique Stremio/Nuvio (les subs de niveau-stream
// ne s'affichent pas dans tous les clients). Résout l'id TMDB puis renvoie les
// sous-titres des sources qui en fournissent (Nabistream), servis par nos propres
// endpoints en text/vtt.
async function handleSubtitles(req: express.Request, res: express.Response, type: string, id: string, config: UserConfig | null) {
  try {
    const parsed = parseStremioId(decodeURIComponent(id));
    const info = await getTmdbInfo(type, parsed.baseId, config);
    if (!info) { res.json({ subtitles: [] }); return; }

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;
    const subtitles: { id: string; url: string; lang: string }[] = [];

    // Nabistream : dramas asiatiques VOSTFR, sous-titres FR/EN.
    try {
      const nbs = await getNabistreamStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode);
      (nbs[0]?.subtitles || []).forEach((s, i) => {
        const label = s.lang === 'fre' ? 'Français' : s.lang === 'eng' ? 'English' : s.lang;
        const su = new URL(`/nabistream/subtitle/${encodeURIComponent(label)}.vtt`, baseUrl);
        su.searchParams.set('u', s.url);
        subtitles.push({ id: `nabistream-${i}-${s.lang}`, url: signUrl(su).toString(), lang: s.lang });
      });
    } catch (e: any) {
      console.log('[Subtitles] Nabistream:', (e?.message || '').slice(0, 80));
    }

    // MovieBox : films/séries, sous-titres multi-langues résolus FRAIS à la lecture
    // (endpoint /moviebox/subtitle, SRT->VTT). Dédoublonné par langue.
    try {
      const mbs = await getMovieboxStreams(info.tmdbId, type as 'movie' | 'series', info.title, info.year, parsed.season, parsed.episode);
      const seenLang = new Set<string>();
      for (const mb of mbs) {
        for (const lang of (mb.subLangs || [])) {
          if (seenLang.has(lang)) continue;
          seenLang.add(lang);
          const label = lang === 'fre' ? 'Français' : lang === 'eng' ? 'English' : lang;
          const s = new URL(`/moviebox/subtitle/${encodeURIComponent(label)}.vtt`, baseUrl);
          s.searchParams.set('sid', mb.subjectId);
          s.searchParams.set('se', String(mb.se));
          s.searchParams.set('ep', String(mb.ep));
          s.searchParams.set('rid', mb.resourceId);
          s.searchParams.set('lang', lang);
          subtitles.push({ id: `moviebox-${lang}`, url: signUrl(s).toString(), lang });
        }
      }
    } catch (e: any) {
      console.log('[Subtitles] MovieBox:', (e?.message || '').slice(0, 80));
    }

    console.log(`[Subtitles] ${type}/${id} -> ${subtitles.length} piste(s)`);
    res.json({ subtitles });
  } catch (e) {
    console.error('[Subtitles] Error:', e);
    res.json({ subtitles: [] });
  }
}

// Stremio peut appendre un segment "extra" (videoHash/videoSize) avant .json :
//   /subtitles/{type}/{id}.json   ou   /subtitles/{type}/{id}/{extra}.json
app.get('/subtitles/:type/:id.json', (req, res) => {
  if (accessEnabled()) return res.status(401).send("Non autorisé : clé d'accès requise");
  handleSubtitles(req, res, req.params.type, req.params.id, null);
});
app.get('/subtitles/:type/:id/:extra.json', (req, res) => {
  if (accessEnabled()) return res.status(401).send("Non autorisé : clé d'accès requise");
  handleSubtitles(req, res, req.params.type, req.params.id, null);
});
app.get('/:config/subtitles/:type/:id.json', (req, res) => {
  const cfg = parseConfig(req.params.config);
  if (denyIfNoAccess(cfg || null, res)) return;
  handleSubtitles(req, res, req.params.type, req.params.id, cfg || null);
});
app.get('/:config/subtitles/:type/:id/:extra.json', (req, res) => {
  const cfg = parseConfig(req.params.config);
  if (denyIfNoAccess(cfg || null, res)) return;
  handleSubtitles(req, res, req.params.type, req.params.id, cfg || null);
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

// StreamFlix / VoirDrama base URLs (read + reload). Files are
// hot-reloaded on edit; this endpoint forces a reload on demand.
app.get('/api/streamflix/endpoints', (req, res) => {
  const reload = req.query.reload === 'true';
  res.json({ ...(reload ? reloadStreamflixEndpoints() : getStreamflixEndpoints()), reloaded: reload });
});
app.get('/api/voirdrama/endpoints', (req, res) => {
  const reload = req.query.reload === 'true';
  res.json({ ...(reload ? reloadVoirDramaEndpoints() : getVoirDramaEndpoints()), reloaded: reload });
});
app.get('/api/voiranime/endpoints', (req, res) => {
  const reload = req.query.reload === 'true';
  res.json({ ...(reload ? reloadVoirAnimeEndpoints() : getVoirAnimeEndpoints()), reloaded: reload });
});
app.get('/api/nabistream/endpoints', (req, res) => {
  const reload = req.query.reload === 'true';
  res.json({ ...(reload ? reloadNabistreamEndpoints() : getNabistreamEndpoints()), reloaded: reload });
});
app.get('/api/coflix/endpoints', (req, res) => {
  const reload = req.query.reload === 'true';
  res.json({ ...(reload ? reloadCoflixEndpoints() : getCoflixEndpoints()), reloaded: reload });
});

// ── Écriture des endpoints depuis l'admin (authentifié) ────────────────────
// Écrit un fichier config/<name> en préservant son _comment, puis appelle le
// reload de la source pour appliquer à chaud.
function configFilePath(fileName: string): string {
  return fsSync.existsSync('/app/config')
    ? `/app/config/${fileName}`
    : path.join(process.cwd(), 'config', fileName);
}
function writeConfigFile(fileName: string, patch: Record<string, unknown>): Record<string, unknown> {
  const p = configFilePath(fileName);
  let current: Record<string, unknown> = {};
  try { if (fsSync.existsSync(p)) current = JSON.parse(fsSync.readFileSync(p, 'utf-8')); } catch { /* start fresh */ }
  const next = { ...current, ...patch };
  fsSync.writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}
// Valide et nettoie une base URL (http/https, sans slash final superflu).
function cleanBaseUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !isValidUrl(v)) return null;
  return v.trim().replace(/\/+$/, '');
}

const jsonBody = express.json({ limit: '8kb' });

// Movix : {api, referer, origin}
app.post('/api/movix/endpoints', requireAdminSession, jsonBody, (req, res) => {
  const api = cleanBaseUrl(req.body?.api);
  if (!api) return res.status(400).json({ ok: false, error: 'api URL invalide' });
  const patch: Record<string, unknown> = { api };
  if (typeof req.body?.referer === 'string' && isValidUrl(req.body.referer)) patch.referer = req.body.referer;
  if (typeof req.body?.origin === 'string' && isValidUrl(req.body.origin)) patch.origin = req.body.origin;
  writeConfigFile('movix-endpoints.json', patch);
  return res.json({ ok: true, ...reloadMovixEndpoints() });
});

// Sources à base unique : {base}
const singleBaseSources: Array<{ path: string; file: string; reload: () => unknown }> = [
  { path: 'frenchstream', file: 'frenchstream-endpoints.json', reload: reloadFrenchStreamEndpoints },
  { path: 'streamflix', file: 'streamflix-endpoints.json', reload: reloadStreamflixEndpoints },
  { path: 'voirdrama', file: 'voirdrama-endpoints.json', reload: reloadVoirDramaEndpoints },
  { path: 'voiranime', file: 'voiranime-endpoints.json', reload: reloadVoirAnimeEndpoints },
  { path: 'nabistream', file: 'nabistream-endpoints.json', reload: reloadNabistreamEndpoints },
  { path: 'coflix', file: 'coflix-endpoints.json', reload: reloadCoflixEndpoints },
];
for (const src of singleBaseSources) {
  app.post(`/api/${src.path}/endpoints`, requireAdminSession, jsonBody, (req, res) => {
    const base = cleanBaseUrl(req.body?.base);
    if (!base) return res.status(400).json({ ok: false, error: 'base URL invalide' });
    writeConfigFile(src.file, { base });
    return res.json({ ok: true, ...(src.reload() as object) });
  });
}

// Whitelist des domaines : lecture (+ statut auto), ajout manuel (authentifié).
app.get('/api/whitelist', (_req, res) => {
  res.json({ domains: getAllowedDomains(), autoWhitelist: process.env.AUTO_WHITELIST === 'true' });
});
app.post('/api/whitelist', requireAdminSession, jsonBody, (req, res) => {
  const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim().toLowerCase() : '';
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return res.status(400).json({ ok: false, error: 'domaine invalide' });
  }
  const added = addAllowedDomain(domain);
  return res.json({ ok: true, added, domains: getAllowedDomains() });
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
  if (ts) {
    if (kind === 'segment') u.searchParams.set('transform', 'ts');
    else u.searchParams.set('transformer', 'ts_stream');
  }
  return signUrl(u).toString(); // &k= si ACCESS_KEY active (route /proxy gardée)
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
    return signUrl(u).toString(); // &k= si ACCESS_KEY active
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

  // Test NetMirror. The scraper's front door is verify.php handing out a guest
  // t_hash_t cookie (the old tv/p.php probe tested a pre-v3 endpoint that now
  // 403s behind Cloudflare — a false "degraded"). Base is env-overridable, same
  // as the scraper, so this follows a domain rotation.
  const nmBase = process.env.NETMIRROR_API_BASE || 'https://net52.cc';
  const nmUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0';
  const netmirrorStart = Date.now();
  try {
    const uuid = `${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
    const resp = await axios.post(`${nmBase}/verify.php`, `g-recaptcha-response=${uuid}`, {
      timeout: 10000,
      headers: { 'User-Agent': nmUA, 'Referer': `${nmBase}/`, 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
      validateStatus: (s: number) => s < 400 || s === 301 || s === 302,
    });
    const setCookie = (resp.headers['set-cookie'] as string[]) || [];
    const hasCookie = setCookie.some(c => /t_hash_t=/.test(c));
    results.netmirror = {
      status: hasCookie ? 'up' : 'degraded',
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


  // FrenchStream, Wiflix and VoirDrama are all served by the Movix API — probe
  // each endpoint against the hot-reloaded Movix base. 200 = the endpoint is
  // alive (a title with no players still returns 200 {success:false}).
  const movixApiProbe = async (name: string, path: string) => {
    const start = Date.now();
    try {
      const resp = await probeGet(`${movixEndpoints.api}/api/${path}`, {
        timeout: 10000,
        headers: { 'Referer': movixEndpoints.referer, 'Origin': movixEndpoints.origin },
        validateStatus: (s: number) => s < 500,
      });
      results[name] = { status: resp.status === 200 ? 'up' : 'degraded', latency: Date.now() - start };
    } catch (e: any) {
      results[name] = { status: 'down', error: e.message };
    }
  };
  await Promise.all([
    movixApiProbe('frenchstream', 'fstream/movie/155'),
    movixApiProbe('wiflix', 'wiflix/movie/155'),
    movixApiProbe('voirdrama', 'drama/tv/93405?season=1&episode=1'),
  ]);

  // MovieBox : la santé = obtenir un Bearer (signature + hosts OK).
  const mbStart = Date.now();
  try {
    const ok = await movieboxProbe();
    results.moviebox = { status: ok ? 'up' : 'degraded', latency: Date.now() - mbStart };
  } catch (e: any) {
    results.moviebox = { status: 'down', error: e.message };
  }

  // VoirAnime : le site répond et sert des fiches /anime/.
  const vaStart = Date.now();
  try {
    const base = getVoirAnimeEndpoints().base;
    const resp = await probeGet(`${base}/`, { timeout: 10000, validateStatus: (s: number) => s < 500 });
    const ok = resp.status === 200 && /\/anime\//.test(String(resp.data || ''));
    results.voiranime = { status: ok ? 'up' : 'degraded', latency: Date.now() - vaStart };
  } catch (e: any) {
    results.voiranime = { status: 'down', error: e.message };
  }

  // Nabistream : l'API publique répond avec du JSON (collection movies).
  const nbStart = Date.now();
  try {
    const base = getNabistreamEndpoints().base;
    const resp = await probeGet(`${base}/proxy/api/movies?limit=1`, { timeout: 10000, validateStatus: (s: number) => s < 500 });
    const ok = resp.status === 200 && Array.isArray((resp.data as any)?.docs);
    results.nabistream = { status: ok ? 'up' : 'degraded', latency: Date.now() - nbStart };
  } catch (e: any) {
    results.nabistream = { status: 'down', error: e.message };
  }

  // Coflix : l'ajax suggest répond avec du JSON {html}.
  const cofStart = Date.now();
  try {
    const base = getCoflixEndpoints().base;
    const resp = await probeGet(`${base}/ajax/search/suggest?keyword=film`, {
      timeout: 10000, headers: { 'X-Requested-With': 'XMLHttpRequest' }, validateStatus: (s: number) => s < 500,
    });
    const ok = resp.status === 200 && typeof (resp.data as any)?.html === 'string';
    results.coflix = { status: ok ? 'up' : 'degraded', latency: Date.now() - cofStart };
  } catch (e: any) {
    results.coflix = { status: 'down', error: e.message };
  }

  const allUp = Object.values(results).every(r => r.status === 'up');
  const allDown = Object.values(results).every(r => r.status === 'down');

  res.json({
    overall: allDown ? 'down' : (allUp ? 'healthy' : 'degraded'),
    sources: results,
    timestamp: new Date().toISOString(),
  });
});

// MovieBox : sert un sous-titre CDN converti SRT->VTT avec le bon content-type.
// Le CDN renvoie du SRT en application/octet-stream sans extension, que Stremio
// ne reconnaît pas ; VTT + text/vtt marche partout (web + desktop).
// MovieBox : sous-titre matché à l'encode (même resourceId), résolu FRAIS puis
// converti SRT->VTT. Le CDN sert du SRT en octet-stream sans extension que
// Stremio ignore ; VTT + text/vtt marche partout. :label est cosmétique.
// Nabistream : re-sert le .vtt (déjà en VTT chez tanastream) depuis notre origine,
// en text/vtt — Nuvio n'affiche pas les sous-titres d'un host tiers direct.
app.get('/nabistream/subtitle/:label', async (req, res) => {
  const u = String(req.query.u || '');
  try {
    const parsed = new URL(u);
    // Anti-SSRF : uniquement le CDN de sous-titres de Nabistream.
    if (parsed.protocol !== 'https:' || !/(^|\.)tanastream\.space$/i.test(parsed.hostname)) {
      res.status(404).end();
      return;
    }
    const resp = await axios.get(u, { responseType: 'text', timeout: 15000, transformResponse: v => v });
    let vtt = String(resp.data).replace(/\r+/g, '');
    if (!/^﻿?WEBVTT/.test(vtt)) vtt = 'WEBVTT\n\n' + vtt; // filet de sécurité
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(vtt);
  } catch {
    res.status(502).end();
  }
});

app.get('/moviebox/subtitle/:label', async (req, res) => {
  const sid = String(req.query.sid || '');
  const se = Number(req.query.se || 0);
  const ep = Number(req.query.ep || 0);
  const rid = String(req.query.rid || '');
  const lang = String(req.query.lang || 'fre');
  if (!sid || !rid) { res.status(400).end(); return; }
  try {
    const url = await resolveMovieboxSubtitle(sid, se, ep, rid, lang);
    if (!url || !/^https:\/\/[a-z0-9.-]*hakunaymatata\.com\//i.test(url)) { res.status(404).end(); return; }
    const resp = await axios.get(url, { responseType: 'text', timeout: 15000, transformResponse: v => v });
    const srt = String(resp.data).replace(/\r+/g, '');
    const vtt = 'WEBVTT\n\n' + srt
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')  // décimales SRT (virgule) -> VTT (point)
      .replace(/[ \t]*-->[ \t]*/g, ' --> ');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(vtt);
  } catch {
    res.status(502).end();
  }
});

// MovieBox : résout le MP4 signé FRAIS (par resourceId) et redirige (302).
// Appelé à la lecture — l'URL signée (t=/sign=) est toujours valide.
app.get('/moviebox/stream', async (req, res) => {
  const sid = String(req.query.sid || '');
  const se = Number(req.query.se || 0);
  const ep = Number(req.query.ep || 0);
  const rid = String(req.query.rid || '');
  if (!sid || !rid) { res.status(400).send('missing sid/rid'); return; }
  try {
    const url = await resolveMovieboxUrl(sid, se, ep, rid);
    if (!url) { res.status(502).send('MovieBox: resolve failed'); return; }
    res.redirect(302, url);
  } catch (e: any) {
    res.status(502).send('MovieBox: ' + (e?.message || 'error'));
  }
});

app.listen(PORT, () => {
  console.log(`LooStream Addon running at http://localhost:${PORT}`);
  console.log(`Install in Stremio: http://localhost:${PORT}/manifest.json`);
  console.log(`Proxy mode: ${DEFAULT_USE_LOCAL_PROXY ? 'LOCAL' : 'MEDIAFLOW (configurable)'}`);
});

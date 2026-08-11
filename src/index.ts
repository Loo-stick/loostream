import express from 'express';
import axios from 'axios';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { getNetmirrorStreams } from './scrapers/netmirror';
import { getWiflixStreams } from './scrapers/wiflix';
import { getVoirDramaStreams, reloadVoirDramaEndpoints, getVoirDramaEndpoints } from './scrapers/voirdrama';
import { getMovieboxStreams, movieboxProbe, resolveMovieboxUrl, resolveMovieboxSubtitle } from './scrapers/moviebox';
import { getVoirAnimeStreams, getVoirAnimeEndpoints, reloadVoirAnimeEndpoints } from './scrapers/voiranime';
import { getAnimeSamaStreams, getAnimesamaEndpoints, reloadAnimesamaEndpoints } from './scrapers/animesama';
import { getAnimeAltTitles } from './anime-titles';
import { getNabistreamStreams, getNabistreamEndpoints, reloadNabistreamEndpoints } from './scrapers/nabistream';
import { getCoflixStreams, getCoflixEndpoints, reloadCoflixEndpoints } from './scrapers/coflix';
import { getStreamFlixStreams, reloadStreamflixEndpoints, getStreamflixEndpoints } from './scrapers/streamflix';
import { getVideasyStreams, reloadVideasyEndpoints, getVideasyEndpoints } from './scrapers/videasy';
import { getMovixStreams, getMovixAnimeStreams, reloadMovixEndpoints, getMovixEndpoints } from './scrapers/movix';
import { getWavewatchStreams } from './scrapers/wavewatch';
import { getNakastreamStreams, NakastreamAuthError, getNakastreamEndpoints } from './scrapers/nakastream';
import { getVostfreeStreams, getVostfreeEndpoints, reloadVostfreeEndpoints } from './scrapers/vostfree';
import { getFrenchStreamStreams, reloadFrenchStreamEndpoints, getFrenchStreamEndpoints } from './scrapers/frenchstream';
import { cached, getCacheStats, clearAll, clearScope } from './cache';
import { recordOutcome, getAllMetrics } from './metrics';
import crypto from 'crypto';
import proxyRouter, { isAllowedUrl, addAllowedDomain, getAllowedDomains } from './proxy';
import { accessEnabled, keyMatches, signUrl, requireQueryKey, ownerKeyMatches, ownerKeyEnabled } from './access';
import { installLogCapture, getLogs } from './logbuffer';
import { getModeRaw, autoWhitelistEnabled, updateSettings, settingsView, netfreeSocksPoolEnabled, isSourceEnabled, getDisabledSources, captureAllLogsEnabled } from './settings';
import { sanitizePseudo, pseudoLabel } from './pseudo';
import { tmdbReq, tmdbKeyType } from './tmdb-auth';
import { runWithLogCapture, capturedLines } from './request-log';
import { recordUserActivity, getUsersOverview, getUserRequests, getRequestLog, isPseudoTakenByOther, claimPseudo, deleteUser } from './user-activity';
import { setPoolEnabled, poolStatus } from './netfree-pool';
import { canDirect } from './deliver';
import * as fsSync from 'fs';
import * as zlib from 'zlib';
import { getFrenchSubtitles, subtitleToVtt } from './subtitles';
import { ExtractorConfig, reloadExtractorDomains, getExtractorDomains, detectExtractor } from './extractors';
import { getSceneMeta, buildFilename, providerLabel } from './filename';
import { buildStreamName, buildStreamTitle } from './display';
import { QUALITY_SCORES, passesPreferences, compareStreams } from './prefs';

// Capture les console.* dans un ring mémoire pour la page Logs de l'admin, le
// plus tôt possible (avant tout autre log de boot). Délègue ensuite à l'original,
// donc les logs Docker restent intacts.
installLogCapture();

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
    videasy: { requests: number; success: number; errors: number; lastSuccess: number | null };
    animesama: { requests: number; success: number; errors: number; lastSuccess: number | null };
    nakastream: { requests: number; success: number; errors: number; lastSuccess: number | null };
    vostfree: { requests: number; success: number; errors: number; lastSuccess: number | null };
    wavewatch: { requests: number; success: number; errors: number; lastSuccess: number | null };
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
    videasy: number;
    animesama: number;
    nakastream: number;
    vostfree: number;
    wavewatch: number;
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
    videasy: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    animesama: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    nakastream: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    vostfree: { requests: 0, success: 0, errors: 0, lastSuccess: null },
    wavewatch: { requests: 0, success: 0, errors: 0, lastSuccess: null },
  },
  streamsServed: { movix: 0, netmirror: 0, streamflix: 0, frenchstream: 0, wiflix: 0, voirdrama: 0, moviebox: 0, voiranime: 0, nabistream: 0, coflix: 0, videasy: 0, animesama: 0, nakastream: 0, vostfree: 0, wavewatch: 0 },
};

function trackSourceResult(source: 'movix' | 'netmirror' | 'streamflix' | 'frenchstream' | 'wiflix' | 'voirdrama' | 'moviebox' | 'voiranime' | 'nabistream' | 'coflix' | 'videasy' | 'animesama' | 'nakastream' | 'vostfree' | 'wavewatch', success: boolean, streamCount: number = 0) {
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
  ownerKey?: string;     // clé propriétaire : bypasse le gate MODE (garde le proxy local)
  prefQuality?: string;  // "1080p", "4K", "720p", "480p"
  langOrder?: string[];  // ["MULTI", "VF", "VOSTFR", "VO"]
  minStreams?: number;   // early exit: stop waiting once this many wanted streams are in (0 = wait for all)
  sortBy?: 'language' | 'quality'; // priorité de tri : langue d'abord (défaut) ou qualité d'abord
  pseudo?: string;       // libellé libre auto-déclaré (support) — optionnel, cf. src/pseudo.ts
  excludeQualities?: string[]; // qualités à EXCLURE (ex. ["4K","360p"]) — filtre opt-in, cf. prefs.ts
  strictFilter?: boolean; // true = exclusion STRICTE (liste vide si rien ne matche) ; false/absent
                          // = souple (relâche la langue mais garde l'exclusion de qualité). cf. filterAndSortStreams
  nakastreamToken?: string; // token de pairing nakastream (per-user, opt-in) — cf. scrapers/nakastream.ts
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
    frSubCount?: number; // nb de sous-titres FR externes (OpenSubtitles) dispo pour le titre
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

// Modes de livraison PROPOSÉS/AUTORISÉS par l'hébergeur, via `MODE` du .env
// (ex. "DIRECT;MFP;LOCAL"). Vide = les trois. Alias : MFP=mediaflow. L'ordre est
// l'ordre de préférence (le 1er est le défaut dans /configure). Sert à la fois
// à l'UI (/api/modes) et au garde de parseConfig.
const MODE_ALIAS: Record<string, 'direct' | 'mediaflow' | 'local'> = {
  direct: 'direct', mfp: 'mediaflow', mediaflow: 'mediaflow', local: 'local',
};
function allowedModes(): ('direct' | 'mediaflow' | 'local')[] {
  const raw = getModeRaw().trim();
  if (!raw) return ['direct', 'mediaflow', 'local'];
  const list = raw.split(/[;,]/).map(s => MODE_ALIAS[s.trim().toLowerCase()]).filter(Boolean);
  return list.length ? [...new Set(list)] as ('direct' | 'mediaflow' | 'local')[] : ['direct', 'mediaflow', 'local'];
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
    // Garde MODE : si l'hébergeur restreint les modes (env MODE) et que le config
    // en demande un non autorisé, on le ramène au 1er mode autorisé. EXCEPTION : un
    // config portant une `ownerKey` valide BYPASSE le gate (l'hébergeur garde ainsi
    // le proxy local pour lui tout en n'offrant que DIRECT/MFP à ses partages).
    const isOwner = ownerKeyMatches(parsed.ownerKey);
    const allowed = allowedModes();
    const proxy: 'local' | 'mediaflow' | 'direct' = (isOwner || allowed.includes(parsed.proxy)) ? parsed.proxy : allowed[0];

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

    // Priorité de tri : 'quality' (qualité d'abord) sinon 'language' (défaut).
    const sortBy: 'language' | 'quality' = parsed.sortBy === 'quality' ? 'quality' : 'language';

    // Qualités à exclure (opt-in) : sous-ensemble des paliers offerts + 'unknown' (sources
    // « HD »/non mesurées, traitées à part — cf. isUnknownQuality dans prefs.ts). Vide -> absent.
    const validExclude = ['4K', '1080p', '720p', '480p', '360p', 'unknown'];
    let excludeQualities = Array.isArray(parsed.excludeQualities)
      ? parsed.excludeQualities.filter((q: unknown) => typeof q === 'string' && validExclude.includes(q))
      : undefined;
    if (excludeQualities && excludeQualities.length === 0) excludeQualities = undefined;

    // Sanitize strings
    return {
      proxy,
      mfUrl: parsed.mfUrl ? sanitizeString(parsed.mfUrl, 500) : undefined,
      mfPass: parsed.mfPass ? sanitizeString(parsed.mfPass, 100) : undefined,
      // ⚠️ 512, PAS 64 : un token v4 (« API Read Access Token ») est un JWT de ~240 car.
      // Tronqué à 64 il perd ses 2e/3e parties -> tmdbKeyType ne le voit plus comme v4 ->
      // repart en ?api_key= avec un token cassé -> 401 -> aucun flux. (v3 = 32 hex, OK.)
      tmdbKey: parsed.tmdbKey ? sanitizeString(parsed.tmdbKey, 512) : undefined,
      accessKey: parsed.accessKey ? sanitizeString(parsed.accessKey, 128) : undefined,
      ownerKey: parsed.ownerKey ? sanitizeString(parsed.ownerKey, 128) : undefined,
      prefQuality,
      langOrder,
      minStreams,
      sortBy,
      strictFilter: parsed.strictFilter === true,
      pseudo: parsed.pseudo !== undefined ? (sanitizePseudo(parsed.pseudo) || undefined) : undefined,
      excludeQualities,
      nakastreamToken: (typeof parsed.nakastreamToken === 'string' && /^[A-Za-z0-9._-]{10,120}$/.test(parsed.nakastreamToken))
        ? parsed.nakastreamToken : undefined,
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
const EARLY_EXIT_GRACE_MS = 1000;   // never answer before this — lets near-tied sources land
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
  onDone: (reason: string, elapsedMs: number) => void,
  waitFor: number[] = []
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
    // Indices de tâches DÉJÀ réglées : l'early-exit est bloqué tant que toutes les
    // tâches `waitFor` (sources anime, lentes mais essentielles) ne sont pas réglées.
    const settledIdx = new Set<number>();
    const mustWaitReady = () => waitFor.every(i => settledIdx.has(i));

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
      if (wanted >= minStreams && Date.now() - started >= EARLY_EXIT_GRACE_MS && mustWaitReady()) {
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
        .then(() => { pending--; settledIdx.add(i); check(); });
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
/** Counts a source's results that pass the user's LANGUAGE prefs + quality exclusion. */
function wantedCounter(source: string, langOrder: string[], excludeQualities?: string[]) {
  return (results: { language?: string; quality?: string }[]) =>
    results.filter(r =>
      passesPreferences({ quality: r.quality || '', language: r.language || '', source }, langOrder, excludeQualities)
    ).length;
}

function filterAndSortStreams(streams: StreamWithMeta[], config: UserConfig | null): StreamWithMeta[] {
  if (!config) return streams;

  const prefQuality = config.prefQuality || '1080p';
  const langOrder = config.langOrder || DEFAULT_LANG_ORDER;
  const prefQualityScore = QUALITY_SCORES[prefQuality] || 3;

  // Filter streams based on preferences (same predicate the early exit counts with).
  // Langue + exclusion de qualité opt-in (excludeQualities) ; la qualité départage au tri.
  let filtered = streams.filter(s => passesPreferences(s._meta, langOrder, config.excludeQualities));

  // Filtre strict vide. Deux comportements au CHOIX de l'utilisateur (config.strictFilter) :
  //  - STRICT (strictFilter=true) : on respecte les exclusions à la lettre -> liste VIDE assumée.
  //  - SOUPLE (défaut) : dégradation gracieuse -> on relâche la LANGUE (préférence) mais on GARDE
  //    l'exclusion de qualité (choix explicite -> jamais réafficher un palier exclu, ex. 360p/480p
  //    sur Toy Story 5 non sorti). Dernier recours (rien ne passe même l'exclusion) : tout.
  if (filtered.length === 0 && !config.strictFilter) {
    filtered = streams.filter(s => passesPreferences(s._meta, DEFAULT_LANG_ORDER, config.excludeQualities));
    if (filtered.length === 0) filtered = streams;
  }

  // Tri : langue d'abord (défaut) ou qualité d'abord, selon config.sortBy.
  const sortBy = config.sortBy || 'language';
  filtered.sort((a, b) => compareStreams(a._meta, b._meta, { langOrder, prefQualityScore, sortBy }));

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
  if (autoWhitelistEnabled()) {
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

// Décide comment livrer un flux. En mode `direct` (hôte directable, pas
// forceLocal), renvoie l'URL CDN BRUTE + les headers -> le draft posera
// behaviorHints.proxyHeaders et Stremio fetch en direct (0 bande passante
// serveur). Sinon, comportement actuel via buildProxyUrl (proxy local/mediaflow).
// `null` = URL bloquée (SSRF) côté proxy.
// Un hôte exige-t-il des en-têtes (Referer/Origin) pour livrer, ou le token dans
// l'URL suffit-il ? Caché par hôte (6h). Détermine, en direct, si on peut servir
// l'URL BRUTE (notWebReady:false -> lecteur natif Stremio, rapide + parallèle) ou
// s'il faut proxyHeaders (notWebReady:true -> serveur interne Stremio, plus lent).
// UA navigateur injecté dans les proxyHeaders des hôtes header-gatés.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Hôtes qui servent une MIRE (/troll/ de ~18s) selon l'User-Agent : ils exigent
// un UA « navigateur » et trollent les UA de lecteur. PROUVÉ pour fsvid : même URL
// index, UA navigateur -> vrai film (650 seg) ; ExoPlayerLib/okhttp/VLC -> mire
// (9 seg / 18s). Nuvio lit via ExoPlayer -> troll en URL brute. Ces hôtes doivent
// donc être servis AVEC proxyHeaders (UA navigateur), jamais en URL brute — le
// lecteur injecte alors le bon UA. Onyx fait pareil (headers navigateur complets).
// AUSSI les hôtes gatés par REFERER (même logique : servir AVEC proxyHeaders, jamais
// en URL brute) : la sonde hostNeedsHeaders est bernée sinon — sans Referer, ces CDN
// renvoient 200 sur une page-gate (ex. citron-edge de StreamFlix -> redirige vers un
// lien Telegram t.me) que la sonde prend pour "header-free". PROUVÉ citron-edge :
// sans Referer -> gate t.me ; avec Referer streamflix.mom -> 206 video/mp4.
// mailru (my.mail.ru, VoirAnime) : la sonde 2-octets voit un 206 sans Referer, mais le
// CDN BRIDE le download soutenu sans lui (mesuré : 7,3 Mbps sans Referer vs 10,7 avec).
// Livré en URL brute -> le client rame sur un 1080p ~5,8 Mbps. Reste DIRECT (0 bande
// passante serveur), juste servi AVEC le Referer d'extraction en proxyHeaders.
const UA_GATED_HOSTS = ['fsvid', 'citron-edge', 'my.mail.ru'];
function isUaGatedHost(host: string): boolean {
  return UA_GATED_HOSTS.some(p => host.includes(p));
}

const HOSTHDR_TTL_MS = 6 * 60 * 60 * 1000;
async function hostNeedsHeaders(streamUrl: string): Promise<boolean> {
  let host: string;
  try { host = new URL(streamUrl).hostname; } catch { return true; }
  // Hôte qui troll selon l'UA -> exige des headers (UA navigateur), pas d'URL brute.
  if (isUaGatedHost(host)) return true;
  return cached<boolean>(
    `hosthdr:${host}`,
    HOSTHDR_TTL_MS,
    async () => {
      try {
        const r = await axios.get(streamUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-1' },
          validateStatus: () => true, timeout: 4000, maxRedirects: 3, responseType: 'arraybuffer',
        });
        return !(r.status === 200 || r.status === 206); // 200/206 sans Referer -> header-free
      } catch { return true; } // doute -> chemin sûr (avec headers)
    },
    { scope: 'hosthdr', shouldCache: () => true },
  );
}

// Hôtes « directables » à relayer quand un PROXY est actif (local/mediaflow) car
// injouables depuis une IP cliente — en direct pur, best-effort (direct+Referer).
// Vérifié sur ligne stable (2026-08-06) : SEUL mail.ru rame vraiment en direct (CDN
// russe, gros fichiers ~5,8 Mbps, peering lointain). fsvid/vidzy (troll UA, réglé) et
// sibnet (chaîne 302 résolue) jouent NICKEL en direct -> volontairement absents ici.
// mail.ru retiré (test 2026-08-07) : Stick veut le tester en DIRECT (économise la bande
// MFP). Le CDN russe peut ramer sur du gros fichier -> réintégrer ici si ça pose souci.
const PREFER_PROXY_HOSTS: string[] = [];
function isPreferProxyHost(streamUrl: string): boolean {
  let host: string;
  try { host = new URL(streamUrl).hostname; } catch { return false; }
  return PREFER_PROXY_HOSTS.some(d => host === d || host.endsWith('.' + d));
}

async function deliver(
  streamUrl: string,
  headers: Record<string, string>,
  opts: { forceLocal?: boolean; forceHls?: boolean; useTransformer?: boolean; forceProxy?: boolean; fixAudioHls?: boolean },
  req: express.Request,
  config: UserConfig | null,
): Promise<{ url: string; proxyHeaders?: Record<string, string> } | null> {
  // Hôte russe + l'utilisateur a un proxy (local/mediaflow) : relayer plutôt que servir
  // en direct (qui rame côté client). En direct pur, on retombe sur le direct+Referer.
  const preferProxy = isPreferProxyHost(streamUrl) && !!config && config.proxy !== 'direct';

  // forceProxy : le flux DOIT passer par le proxy DU MODE (Videasy header-gaté) — jamais
  // en direct. En MFP -> MediaFlow, en local -> proxy local, en direct pur -> écarté
  // (return null plus bas). Contrairement à forceLocal, il NE force PAS le proxy local :
  // il respecte le mode -> pas de fuite « proxy local » quand seul MFP/direct est autorisé.
  if (!opts.forceProxy && !preferProxy && canDirect(streamUrl, !!opts.forceLocal)) {
    // Master HLS multi-audio livré en direct : beaucoup déclarent des pistes audio
    // séparées sans DEFAULT=YES -> « vidéo sans son » sur les players stricts, et un
    // stream direct ne peut PAS être réécrit côté player. On sert le master corrigé via
    // /proxy/fixaudio (injecte DEFAULT=YES), les enfants restent en ABSOLU CDN -> segments
    // toujours en direct (pas de bande passante chez nous). Reste « direct » pour le badge.
    if (opts.fixAudioHls && (opts.forceHls || isHlsUrl(streamUrl))) {
      const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
      const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
      const u = new URL('/proxy/fixaudio', `${proto}://${host}`);
      u.searchParams.set('url', streamUrl);
      for (const [k, v] of Object.entries(headers)) u.searchParams.set(`h_${k.toLowerCase()}`, v);
      return { url: signUrl(u).toString() };
    }
    // Hôte header-free -> URL brute (lecteur natif Stremio, rapide). Sinon
    // proxyHeaders (nécessaire, mais passe par le serveur interne Stremio, lent).
    const needsHdr = await hostNeedsHeaders(streamUrl);
    if (!needsHdr) return { url: streamUrl };
    // Header-gaté : garantir un UA navigateur dans les proxyHeaders (fsvid & co
    // trollent les UA de lecteur ExoPlayer/okhttp). Un UA explicite de l'extracteur
    // reste prioritaire ; sinon on force le navigateur.
    return { url: streamUrl, proxyHeaders: { 'User-Agent': BROWSER_UA, ...headers } };
  }
  // Flux NON-directable (NetMirror / hôte bloqué) : le mode choisit le fallback.
  // 'direct' = « sans proxy » -> on n'offre pas ce flux du tout.
  if (config?.proxy === 'direct') return null;
  const url = buildProxyUrl(
    streamUrl, headers, opts.useTransformer ?? false, req, config,
    opts.forceLocal ?? false, opts.forceHls ?? false,
  );
  return url ? { url } : null;
}

// Déduit le mode de livraison d'un flux finalisé (pour le badge d'affichage) :
// direct (CDN->client, 0 relais), local (notre /proxy ou /netmirror) ou mediaflow.
function computeDelivery(url: string, hasProxyHeaders: boolean, config: UserConfig | null): 'direct' | 'local' | 'mediaflow' {
  if (hasProxyHeaders) return 'direct';
  // MediaFlow d'ABORD : ses URLs contiennent /proxy/hls/ dans le chemin, il ne
  // faut pas les confondre avec notre proxy local (distinction par l'hôte).
  const mfUrl = config?.mfUrl || DEFAULT_MEDIAFLOW_URL;
  if (mfUrl) {
    try { if (new URL(url).hostname.includes(new URL(mfUrl).hostname)) return 'mediaflow'; } catch { /* ignore */ }
  }
  if (url.includes('/proxy/fixaudio')) return 'direct'; // master corrigé, segments en direct CDN
  if (url.includes('/proxy/') || url.includes('/netmirror/')) return 'local';
  if (url.includes('/moviebox/')) return 'direct'; // 302 -> CDN, aucun relais serveur
  return 'direct'; // URL CDN brute sans en-têtes = pas de relais
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
    version: '1.18.1',
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

// Test d'une clé TMDB (v3 api_key OU v4 Bearer) — utilisé par le wizard configure
// (bouton « Tester » + validation à la génération). Public : ne teste que la clé fournie.
app.get('/api/tmdb/check', async (req, res) => {
  const key = String(req.query.key || '').trim();
  if (!key) return res.json({ valid: false, type: 'unknown' });
  const type = tmdbKeyType(key);
  if (type === 'unknown') return res.json({ valid: false, type });
  try {
    const rq = tmdbReq('configuration', key);
    const r = await axios.get(rq.url, { headers: rq.headers, timeout: 8000, validateStatus: () => true });
    return res.json({ valid: r.status === 200, type, status: r.status });
  } catch (e: any) {
    return res.json({ valid: false, type, error: e?.message || 'réseau' });
  }
});

// Test de la clé d'accès (si l'hébergeur en exige une). Pas de nouvel oracle : la route
// /:config/manifest.json valide déjà la clé (200/401), et la clé est à haute entropie.
app.get('/api/access/check', (req, res) => {
  if (!accessEnabled()) return res.json({ valid: true, required: false });
  const key = String(req.query.key || '');
  return res.json({ valid: keyMatches(key), required: true });
});

// Unicité du pseudo : déjà utilisé par une clé TMDB DIFFÉRENTE ? (une clé peut avoir
// plusieurs pseudos ; la re-config pré-remplit clé+pseudo -> même hash -> pas de collision).
app.get('/api/pseudo/check', (req, res) => {
  const pseudo = sanitizePseudo(String(req.query.pseudo || ''));
  if (!pseudo) return res.json({ taken: false });
  const taken = isPseudoTakenByOther(pseudo, tmdbKeyHash(String(req.query.key || '')));
  return res.json({ taken });
});
// Revendique le pseudo à la GÉNÉRATION du lien (réserve pour cette clé si libre).
app.post('/api/pseudo/claim', express.json({ limit: '4kb' }), (req, res) => {
  const b = req.body || {};
  const pseudo = sanitizePseudo(String(b.pseudo || ''));
  if (!pseudo) return res.json({ ok: true });
  const ok = claimPseudo(pseudo, tmdbKeyHash(String(b.key || '')));
  return res.json({ ok, taken: !ok });
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

// Hash court de la clé TMDB : identifie « le même utilisateur » pour l'unicité du pseudo
// (une clé peut porter PLUSIEURS pseudos ; un pseudo ne peut appartenir qu'à UNE clé).
function tmdbKeyHash(key: string): string {
  const k = (key || '').trim();
  return k ? crypto.createHash('sha256').update(k).digest('hex').slice(0, 16) : '';
}

const TMDB_TTL_MS = 12 * 60 * 60 * 1000;

type MediaInfo = { title: string; originalTitle: string; frenchTitle: string; year: string; tmdbId: string; imdbId: string; originalLanguage: string };

// Repli Cinemeta (métadonnées IMDB de Stremio) quand TMDB ne connaît pas l'IMDB — FRÉQUENT
// pour l'anime à entrée IMDB séparée (ex. « Bleach: Thousand-Year Blood War » tt14986406,
// que TMDB range sous la série d'origine). On récupère titre + année et on détecte l'anime
// (genre Animation + pays Japon) pour que les scrapers titre-keyés (VoirAnime/AnimeSama)
// tournent. tmdbId reste vide -> les sources tmdb-keyées renvoient simplement vide.
async function cinemetaInfo(type: string, id: string): Promise<MediaInfo | null> {
  try {
    const kind = type === 'movie' ? 'movie' : 'series';
    const { data } = await axios.get(`https://v3-cinemeta.strem.io/meta/${kind}/${id}.json`, { timeout: 8000 });
    const m = data?.meta;
    if (!m?.name) return null;
    const year = (String(m.year || m.releaseInfo || '').match(/\d{4}/) || [''])[0];
    const genres = Array.isArray(m.genres) ? m.genres.map((g: any) => String(g).toLowerCase()) : [];
    const isAnime = genres.includes('animation') && /japan|jp/i.test(String(m.country || ''));
    console.log(`[Stream] TMDB manquant -> repli Cinemeta: "${m.name}" (${year})${isAnime ? ' [anime]' : ''}`);
    return {
      title: m.name, originalTitle: m.name, frenchTitle: '', year,
      tmdbId: '', imdbId: id, originalLanguage: isAnime ? 'ja' : '',
    };
  } catch { return null; }
}

// Season-mapping ANIME pour les sources tmdb-keyées (Movix…). Nuvio traite un cour d'anime
// comme SA propre série (ex. « Bleach: TYBW » S1E1), alors que TMDB le range sous la série
// parente avec des saisons décalées (Bleach tmdb 30984, TYBW = saison 2, 50 ép). On mappe
// par DATE DE DIFFUSION : date de l'épisode demandé (Cinemeta) -> série parente (recherche
// titre) -> saison+épisode TMDB de même date. Caché (résultat stable).
async function resolveAnimeTmdbMapping(imdbId: string, title: string, season: number, episode: number, tmdbKey: string): Promise<{ tmdbId: string; season: number; episode: number } | null> {
  if (!imdbId || !tmdbKey) return null;
  return cached(`animemap:${imdbId}:${season}:${episode}`, TMDB_TTL_MS, async () => {
    try {
      const { data: cine } = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, { timeout: 8000 });
      const vid = (cine?.meta?.videos || []).find((v: any) => Number(v.season) === season && Number(v.episode) === episode);
      const air = String(vid?.released || vid?.firstAired || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(air)) return null;
      const airT = Date.parse(air);
      const base = (title.split(/\s*[:–—-]\s+/)[0] || title).trim();
      const rq1 = tmdbReq(`search/tv?query=${encodeURIComponent(base)}`, tmdbKey);
      const { data: search } = await axios.get(rq1.url, { headers: rq1.headers, timeout: 8000 });
      const cand = (search?.results || [])[0];
      if (!cand) return null;
      const rq2 = tmdbReq(`tv/${cand.id}`, tmdbKey);
      const { data: det } = await axios.get(rq2.url, { headers: rq2.headers, timeout: 8000 });
      const seasons = (det?.seasons || []).filter((s: any) => s.season_number > 0 && s.air_date)
        .sort((a: any, b: any) => Date.parse(a.air_date) - Date.parse(b.air_date));
      let target: any = null;
      for (const s of seasons) if (Date.parse(s.air_date) <= airT + 2 * 864e5) target = s; // dernière saison commençant avant la date
      if (!target) return null;
      const rq3 = tmdbReq(`tv/${cand.id}/season/${target.season_number}`, tmdbKey);
      const { data: sd } = await axios.get(rq3.url, { headers: rq3.headers, timeout: 8000 });
      const ep = (sd?.episodes || []).find((e: any) => e.air_date && Math.abs(Date.parse(e.air_date) - airT) <= 2 * 864e5);
      if (!ep) return null;
      console.log(`[Stream] Anime mapping: ${imdbId} S${season}E${episode} -> tmdb ${cand.id} S${target.season_number}E${ep.episode_number} (${air})`);
      return { tmdbId: String(cand.id), season: target.season_number, episode: ep.episode_number };
    } catch { return null; }
  }, { scope: 'tmdb', shouldCache: r => r !== null });
}

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
          const rqf = tmdbReq(`find/${id}?external_source=imdb_id`, tmdbKey);
          const findResp = await axios.get(rqf.url, { headers: rqf.headers });
          const results = type === 'movie' ? findResp.data.movie_results : findResp.data.tv_results;
          if (!results || results.length === 0) return await cinemetaInfo(type, id); // TMDB ne mappe pas cet IMDB
          tmdbId = String(results[0].id);
        } else if (id.startsWith('tmdb:')) {
          tmdbId = id.replace('tmdb:', '').split(':')[0];
        }

        const endpoint = type === 'movie' ? 'movie' : 'tv';
        // Détails EN + FR en parallèle : les sites FR indexent par titre français,
        // mais on ne veut pas payer un aller-retour TMDB séquentiel de plus.
        const rqEn = tmdbReq(`${endpoint}/${tmdbId}`, tmdbKey);
        const rqFr = tmdbReq(`${endpoint}/${tmdbId}?language=fr-FR`, tmdbKey);
        const [resp, frResp] = await Promise.all([
          axios.get(rqEn.url, { headers: rqEn.headers }),
          axios.get(rqFr.url, { headers: rqFr.headers }).catch(() => null),
        ]);

        const title = resp.data.title || resp.data.name;
        // Original (romaji) title — anime often lives under it on FR sites
        // (jigokuraku, shingeki-no-kyojin) rather than the English title.
        const originalTitle = resp.data.original_title || resp.data.original_name || '';
        const year = (resp.data.release_date || resp.data.first_air_date || '').split('-')[0];

        let imdbId = id.startsWith('tt') ? id : (resp.data.imdb_id || '');
        if (!imdbId) {
          try {
            const rqx = tmdbReq(`${endpoint}/${tmdbId}/external_ids`, tmdbKey);
            const ext = await axios.get(rqx.url, { headers: rqx.headers });
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

  // Pseudo OBLIGATOIRE : sans pseudo dans la config, l'addon ne sert AUCUN flux. On
  // renvoie une entrée informative (externalUrl) qui ouvre /configure — avec la config
  // actuelle pré-remplie quand elle existe — pour que l'utilisateur ajoute son pseudo.
  if (!sanitizePseudo(config?.pseudo)) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    const base = `${proto}://${host}`;
    const cfgParam = (req.params as { config?: string }).config;
    const cfgUrl = cfgParam ? `${base}/${cfgParam}/configure` : `${base}/configure`;
    console.log('[Stream] ⛔ Pseudo requis — aucun flux servi (config sans pseudo)');
    return res.json({ streams: [{
      name: 'LooStream ⚠️',
      title: 'Pseudo requis\nOuvre la configuration et ajoute un pseudo pour activer l\'addon.',
      externalUrl: cfgUrl,
    }] });
  }

  // Tracking Users (logs détaillés par utilisateur). `recTitle`/`perSourceSummary` sont hors
  // du try pour rester lisibles dans le catch. `record` ne LIT PAS `info` (sinon on perd le
  // narrowing de `const info`) : le titre passe par `recTitle`. `log` complet stocké pour les
  // problèmes (empty/error) ou si captureAllLogs, sinon rien (échelle).
  const who = pseudoLabel(config?.pseudo);
  const whoKeyHash = tmdbKeyHash(config?.tmdbKey || DEFAULT_TMDB_KEY);
  let recTitle: string | undefined;
  const perSourceSummary: Record<string, number> = {};
  const record = (streams: number, outcome: 'ok' | 'empty' | 'error') => {
    const logForOutcome = (outcome !== 'ok' || captureAllLogsEnabled()) ? capturedLines() : null;
    recordUserActivity(who, {
      mediaType: type, contentId: id, title: recTitle,
      streams, outcome, detail: JSON.stringify(perSourceSummary), log: logForOutcome,
    }, whoKeyHash);
  };

  try {
    const parsed = parseStremioId(decodeURIComponent(id));
    const info = await getTmdbInfo(type, parsed.baseId, config);

    if (!info) {
      console.log('[Stream] Could not get TMDB info');
      record(0, 'empty');
      return res.json({ streams: [] });
    }
    recTitle = info.title;

    console.log(`[Stream] 👤 ${who} · Title: ${info.title} (${info.year})`);

    // Sous-titres FR externes (OpenSubtitles) : nombre dispo pour le titre, calculé
    // EN PARALLÈLE des scrapers (caché 12h) et affiché sur chaque carte (🇫🇷 N).
    const frSubsPromise = info.imdbId
      ? getFrenchSubtitles(info.imdbId, type === 'series' ? parsed.season : undefined, type === 'series' ? parsed.episode : undefined).catch(() => [])
      : Promise.resolve([]);

    // Fetch from all sources in parallel (with stats tracking)
    stats.requests.total++;
    stats.requests.streams++;

    // Build extractor config based on user settings. MediaFlow SEULEMENT en mode
    // 'mediaflow' : en 'direct' (comme en 'local') on extrait localement, sinon
    // voe/doodstream ressortent en URL MediaFlow qu'on servirait à tort en direct.
    const extractorConfig: ExtractorConfig = {
      useMediaFlow: config?.proxy === 'mediaflow',
      mediaFlowUrl: config?.mfUrl || DEFAULT_MEDIAFLOW_URL,
      mediaFlowPassword: config?.mfPass || DEFAULT_MEDIAFLOW_PASSWORD,
    };

    const langOrder = config?.langOrder || DEFAULT_LANG_ORDER;
    const minStreams = config?.minStreams ?? DEFAULT_MIN_STREAMS;

    // Titre ROMAJI (AniList, keyless) pour l'anime : les sites FR indexent souvent en
    // romaji. Lancé EN PARALLÈLE du fan-out (seuls VoirAnime/AnimeSama l'attendent),
    // gaté ja -> zéro coût pour le reste. [] si non-anime ou lookup KO.
    const animeAltsPromise: Promise<string[]> = info.originalLanguage === 'ja'
      ? getAnimeAltTitles(info.title, info.originalTitle).catch(() => [])
      : Promise.resolve([]);

    // Le proxy LOCAL est-il autorisé pour ce config ? local ∈ MODE OU ownerKey valide.
    // NetMirror (livrable QUE en local) n'est même pas SCRAPÉ si non — inutile (jusqu'à
    // 9 aller-retours). RÈGLE : jamais de proxy local si seuls MFP/direct sont permis (hors owner).
    const localProxyAllowed = allowedModes().includes('local') || ownerKeyMatches(config?.ownerKey);

    // nakastream : token expiré/révoqué -> on lève NakastreamAuthError dans le .catch et
    // on pose ce flag ; en fin de handler on ajoute UNE entrée « reconnecte » NON-bloquante.
    let nakastreamAuthFailed = false;

    // Sources désactivées manuellement (admin) -> skippées ici (Promise.resolve([]),
    // zéro latence, absentes des résultats). isSourceEnabled lit le réglage à chaud.
    const sourcePromises = [
      (isSourceEnabled('netmirror') && localProxyAllowed
        ? getNetmirrorStreams(info.title, info.year, type as 'movie' | 'series', parsed.season, parsed.episode, info.originalLanguage)
        : Promise.resolve([]))
        .then(r => { trackSourceResult('netmirror', true, r.length); recordOutcome('netmirror', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[NetMirror] Error:', e); trackSourceResult('netmirror', false); recordOutcome('netmirror', 'error', e?.message); return []; }),
      (isSourceEnabled('streamflix') ? getStreamFlixStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, config?.tmdbKey || DEFAULT_TMDB_KEY) : Promise.resolve([]))
        .then(r => { trackSourceResult('streamflix', true, r.length); recordOutcome('streamflix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[StreamFlix] Error:', e); trackSourceResult('streamflix', false); recordOutcome('streamflix', 'error', e?.message); return []; }),
      (isSourceEnabled('movix') ? (async () => {
        const isAnime = info.originalLanguage === 'ja' && type === 'series' && !!parsed.season && !!parsed.episode;
        // Anime sans tmdb direct (repli Cinemeta) : mappe vers (tmdb parent, saison, ép) par
        // date de diffusion pour atteindre le Movix (purstream/cpasmal…) rangé sous la série parente.
        let mvId = info.tmdbId, mvS = parsed.season, mvE = parsed.episode;
        if (!info.tmdbId && isAnime) {
          const map = await resolveAnimeTmdbMapping(info.imdbId, info.title, parsed.season!, parsed.episode!, config?.tmdbKey || DEFAULT_TMDB_KEY);
          if (map) { mvId = map.tmdbId; mvS = map.season; mvE = map.episode; }
        }
        // En plus des providers tmdb-keyés : l'API anime de Movix (anime-sama) — atteint les
        // arcs (TYBW Partie N) qu'anime-sama range sous la franchise, avec sibnet/ansembed VOSTFR+VF.
        const animePart = isAnime
          ? animeAltsPromise.then(alts => getMovixAnimeStreams([info.title, info.originalTitle, info.frenchTitle, ...alts].filter(Boolean) as string[], type as 'movie' | 'series', parsed.season, parsed.episode, extractorConfig))
          : Promise.resolve([] as Awaited<ReturnType<typeof getMovixStreams>>);
        const tmdbPart = mvId ? getMovixStreams(mvId, type as 'movie' | 'series', mvS, mvE, extractorConfig) : Promise.resolve([] as Awaited<ReturnType<typeof getMovixStreams>>);
        const [a, b] = await Promise.all([tmdbPart, animePart]);
        return [...a, ...b];
      })() : Promise.resolve([]))
        .then(r => { trackSourceResult('movix', true, r.length); recordOutcome('movix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Movix] Error:', e); trackSourceResult('movix', false); recordOutcome('movix', 'error', e?.message); return []; }),
      (isSourceEnabled('frenchstream') ? getFrenchStreamStreams(info.tmdbId, type as 'movie' | 'series', extractorConfig, config?.tmdbKey || DEFAULT_TMDB_KEY, parsed.season, parsed.episode) : Promise.resolve([]))
        .then(r => { trackSourceResult('frenchstream', true, r.length); recordOutcome('frenchstream', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[FrenchStream] Error:', e); trackSourceResult('frenchstream', false); recordOutcome('frenchstream', 'error', e?.message); return []; }),
      (isSourceEnabled('wiflix') ? getWiflixStreams(info.tmdbId, type as 'movie' | 'series', extractorConfig, parsed.season, parsed.episode) : Promise.resolve([]))
        .then(r => { trackSourceResult('wiflix', true, r.length); recordOutcome('wiflix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Wiflix] Error:', e); trackSourceResult('wiflix', false); recordOutcome('wiflix', 'error', e?.message); return []; }),
      (isSourceEnabled('voirdrama') ? getVoirDramaStreams(info.tmdbId, type as 'movie' | 'series', extractorConfig, parsed.season, parsed.episode, info.title, info.originalLanguage) : Promise.resolve([]))
        .then(r => { trackSourceResult('voirdrama', true, r.length); recordOutcome('voirdrama', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[VoirDrama] Error:', e); trackSourceResult('voirdrama', false); recordOutcome('voirdrama', 'error', e?.message); return []; }),
      (isSourceEnabled('moviebox') ? getMovieboxStreams(info.tmdbId, type as 'movie' | 'series', info.title, info.year, parsed.season, parsed.episode) : Promise.resolve([]))
        .then(r => { trackSourceResult('moviebox', true, r.length); recordOutcome('moviebox', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[MovieBox] Error:', e); trackSourceResult('moviebox', false); recordOutcome('moviebox', 'error', e?.message); return []; }),
      // VoirAnime : anime uniquement (originalLanguage japonais).
      (isSourceEnabled('voiranime') && info.originalLanguage === 'ja'
        ? animeAltsPromise.then(alts => getVoirAnimeStreams(parsed.baseId, type as 'movie' | 'series', extractorConfig, parsed.season, parsed.episode, info.title, info.originalTitle, alts))
        : Promise.resolve([]))
        .then(r => { if (info.originalLanguage === 'ja') { trackSourceResult('voiranime', true, r.length); recordOutcome('voiranime', r.length > 0 ? 'success' : 'empty'); } return r; })
        .catch(e => { console.log('[VoirAnime] Error:', e); trackSourceResult('voiranime', false); recordOutcome('voiranime', 'error', e?.message); return []; }),
      // Nabistream : dramas coréens/asiatiques VOSTFR (API keyée TMDB).
      (isSourceEnabled('nabistream') ? getNabistreamStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode) : Promise.resolve([]))
        .then(r => { trackSourceResult('nabistream', true, r.length); recordOutcome('nabistream', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Nabistream] Error:', e); trackSourceResult('nabistream', false); recordOutcome('nabistream', 'error', e?.message); return []; }),
      // Coflix : films/séries FR généralistes (titre FR d'abord, anglais en repli).
      (isSourceEnabled('coflix') ? getCoflixStreams(type as 'movie' | 'series', extractorConfig, parsed.season, parsed.episode, info.frenchTitle || info.title, info.title, info.year ? Number(info.year) : undefined) : Promise.resolve([]))
        .then(r => { trackSourceResult('coflix', true, r.length); recordOutcome('coflix', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Coflix] Error:', e); trackSourceResult('coflix', false); recordOutcome('coflix', 'error', e?.message); return []; }),
      // Videasy : agrégateur VO (anglais) + sous-titres, keyé TMDB.
      (isSourceEnabled('videasy') ? getVideasyStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, config?.tmdbKey || DEFAULT_TMDB_KEY) : Promise.resolve([]))
        .then(r => { trackSourceResult('videasy', true, r.length); recordOutcome('videasy', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[Videasy] Error:', e); trackSourceResult('videasy', false); recordOutcome('videasy', 'error', e?.message); return []; }),
      // AnimeSama : anime uniquement (originalLanguage japonais).
      (isSourceEnabled('animesama') && info.originalLanguage === 'ja'
        ? animeAltsPromise.then(alts => getAnimeSamaStreams(type as 'movie' | 'series', [info.title, info.originalTitle, info.frenchTitle, ...alts].filter(Boolean) as string[], parsed.season, parsed.episode, extractorConfig))
        : Promise.resolve([]))
        .then(r => { if (info.originalLanguage === 'ja') { trackSourceResult('animesama', true, r.length); recordOutcome('animesama', r.length > 0 ? 'success' : 'empty'); } return r; })
        .catch(e => { console.log('[AnimeSama] Error:', e); trackSourceResult('animesama', false); recordOutcome('animesama', 'error', e?.message); return []; }),
      // nakastream : source OPT-IN par utilisateur (token de pairing dans la config).
      (isSourceEnabled('nakastream') && config?.nakastreamToken
        ? getNakastreamStreams(config.nakastreamToken, info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, info.title)
        : Promise.resolve([]))
        .then(r => { if (config?.nakastreamToken) { trackSourceResult('nakastream', true, r.length); recordOutcome('nakastream', r.length > 0 ? 'success' : 'empty'); } return r; })
        .catch(e => {
          if (e instanceof NakastreamAuthError) { nakastreamAuthFailed = true; recordOutcome('nakastream', 'error', 'auth'); }
          else { console.log('[Nakastream] Error:', e); trackSourceResult('nakastream', false); recordOutcome('nakastream', 'error', e?.message); }
          return [];
        }),
      // Vostfree : anime VF/VOSTFR uniquement (originalLanguage japonais), keyé titre.
      (isSourceEnabled('vostfree') && info.originalLanguage === 'ja'
        ? animeAltsPromise.then(alts => getVostfreeStreams(parsed.baseId, type as 'movie' | 'series', extractorConfig, parsed.season, parsed.episode, [info.title, info.originalTitle, info.frenchTitle, ...alts].filter(Boolean) as string[]))
        : Promise.resolve([]))
        .then(r => { if (info.originalLanguage === 'ja') { trackSourceResult('vostfree', true, r.length); recordOutcome('vostfree', r.length > 0 ? 'success' : 'empty'); } return r; })
        .catch(e => { console.log('[Vostfree] Error:', e); trackSourceResult('vostfree', false); recordOutcome('vostfree', 'error', e?.message); return []; }),
      // WaveWatch / ToFlix : agrégateur d'embeds keyé par tmdbId (finepulfe m3u8 direct +
      // hôtes vidzy/uqload/vidara/fsvid…). Skippé sans tmdbId (return [] interne).
      (isSourceEnabled('wavewatch') && info.tmdbId
        ? getWavewatchStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, extractorConfig)
        : Promise.resolve([]))
        .then(r => { if (info.tmdbId) { trackSourceResult('wavewatch', true, r.length); recordOutcome('wavewatch', r.length > 0 ? 'success' : 'empty'); } return r; })
        .catch(e => { console.log('[Wavewatch] Error:', e); trackSourceResult('wavewatch', false); recordOutcome('wavewatch', 'error', e?.message); return []; }),
    ];

    const SOURCE_NAMES = ['netmirror', 'streamflix', 'movix', 'frenchstream', 'wiflix', 'voirdrama', 'moviebox', 'voiranime', 'nabistream', 'coflix', 'videasy', 'animesama', 'nakastream', 'vostfree', 'wavewatch'];
    const collected = await collectSources(
      sourcePromises.map((promise, i) => ({
        name: SOURCE_NAMES[i],
        promise,
        countWanted: wantedCounter(SOURCE_NAMES[i], langOrder, config?.excludeQualities),
      })),
      minStreams,
      (reason, ms) => console.log(`[Stream] Fan-out terminé: ${reason}${ms ? ` en ${(ms / 1000).toFixed(2)}s` : ''}`),
      // Anime : les sources anime (VoirAnime/AnimeSama) sont LENTES (scraping) mais
      // c'est TOUT l'intérêt pour un anime -> l'early-exit doit les attendre, sinon
      // Videasy (3 flux instantanés) atteint le quota et les coupe. Plafonné par le
      // deadline (20s). Aucun effet hors anime.
      info.originalLanguage === 'ja'
        ? [SOURCE_NAMES.indexOf('voiranime'), SOURCE_NAMES.indexOf('animesama'), SOURCE_NAMES.indexOf('vostfree')]
        : []
    );

    // Résumé par source pour le tracking Users (nb de flux rendus par chaque source).
    SOURCE_NAMES.forEach((n, i) => {
      const r = collected[i];
      if (Array.isArray(r) && r.length) perSourceSummary[n] = r.length;
    });

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
    const videasyResults = collected[10] as Awaited<ReturnType<typeof getVideasyStreams>>;
    const animesamaResults = collected[11] as Awaited<ReturnType<typeof getAnimeSamaStreams>>;
    const nakastreamResults = collected[12] as Awaited<ReturnType<typeof getNakastreamStreams>>;
    const vostfreeResults = collected[13] as Awaited<ReturnType<typeof getVostfreeStreams>>;
    const wavewatchResults = collected[14] as Awaited<ReturnType<typeof getWavewatchStreams>>;

    // On accumule des "drafts" (streams sans name/title). name/title sont posés
    // en UNE passe centralisée plus bas (src/display.ts), pour un rendu uniforme.
    type StreamDraft = Omit<StreamWithMeta, 'name' | 'title'>;
    const drafts: StreamDraft[] = [];

    // Process Movix results
    for (const mv of movixResults) {
      let finalUrl: string;
      let proxyHdrs: Record<string, string> | undefined; // posé si livraison directe

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
        // Un embed RÉSOLU par extracteur (fsvid/streamwish/premium…) se livre en DIRECT,
        // comme FrenchStream : fixaudio re-fetch le master CÔTÉ SERVEUR, ce qui mint des
        // tokens fsvid IP/rate-bound -> le player (IP résidentielle) se fait ensuite
        // TROLLER (/troll/ FSTREAM.TOP). Seuls les masters purstream PROPRES à Movix
        // (CDN non reconnu comme extracteur, multi-audio à pistes séparées sans DEFAULT=YES)
        // passent par fixaudio -> on sert alors le master corrigé (segments directs).
        const isResolvedEmbed = detectExtractor(mv.url) !== null;
        const opts = isResolvedEmbed ? {} : { forceHls: isHls, fixAudioHls: isHls };
        const d = await deliver(mv.url, proxyHeaders, opts, req, config);

        if (!d) continue; // Skip blocked URLs
        finalUrl = d.url;
        proxyHdrs = d.proxyHeaders;
      }

      drafts.push({
        url: finalUrl,
        behaviorHints: {
          notWebReady: !!proxyHdrs,
          bingeGroup: 'movix',
          ...(proxyHdrs ? { proxyHeaders: { request: proxyHdrs } } : {}),
        },
        _meta: {
          quality: mv.quality,
          language: mv.language,
          source: 'movix',
          server: mv.server,
        },
      });
    }

    // Process WaveWatch results (agrégateur tmdbId). Deux types :
    //  - direct (finepulfe m3u8 multi-audio) : le CDN 403 tout refetch serveur (Cloudflare)
    //    -> livraison DIRECTE stricte (opts={}), surtout PAS fixaudio (qui refetch le master).
    //  - embed résolu (vidzy/uqload/vidara/vidsonic…) : même logique que Movix.
    for (const wv of wavewatchResults) {
      let finalUrl: string;
      let proxyHdrs: Record<string, string> | undefined;

      const mfUrl = config?.mfUrl || DEFAULT_MEDIAFLOW_URL;
      const isMediaFlowUrl = mfUrl && wv.url.includes(new URL(mfUrl).hostname);

      if (isMediaFlowUrl) {
        finalUrl = wv.url;
      } else if (wv.forceProxy) {
        // m3u8 direct UA-gaté (finepulfe) : segments 403 sur l'UA du player -> DOIT passer par un
        // proxy qui fetch avec CDN_UA + réécrit le manifeste (multi-audio + subs). deliver() renvoie
        // null en mode 'direct' -> on construit l'URL nous-mêmes, comme NetMirror. MFP -> MediaFlow
        // (offload) ; sinon proxy LOCAL, gaté `localProxyAllowed` (owner/local) pour ne pas faire
        // tirer 200 users publics sur notre bande passante. Ni l'un ni l'autre -> non offert.
        const mfU = config?.mfUrl || DEFAULT_MEDIAFLOW_URL;
        let purl: string | null = null;
        if (config?.proxy === 'mediaflow' && mfU) {
          purl = buildProxyUrl(wv.url, { ...wv.headers }, false, req, config, false, true);
        } else if (localProxyAllowed) {
          purl = buildProxyUrl(wv.url, { ...wv.headers }, false, req, config, true, true);
        }
        if (!purl) continue;
        finalUrl = purl;
      } else {
        const proxyHeaders: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...wv.headers,
        };
        const isHls = wv.format === 'm3u8';
        // Embed résolu (fsvid/vidara/…) : livraison DIRECTE comme Movix (fixaudio refetch = troll).
        // EXCEPTION vidsonic : son CDN résolu (encoder-fin.vidsonic.net) matche encore son propre
        // extracteur -> serait vu comme « résolu » et livré brut. Or Nuvio ne lit PAS le HLS brut
        // (les flux qui MARCHENT passent par le proxy) -> on le route via fixaudio (master proxifié).
        const isResolvedEmbed = detectExtractor(wv.url) !== null && !/vidsonic\.net/i.test(wv.url);
        const opts = isResolvedEmbed ? {} : { forceHls: isHls, fixAudioHls: isHls };
        const d = await deliver(wv.url, proxyHeaders, opts, req, config);
        if (!d) continue;
        finalUrl = d.url;
        proxyHdrs = d.proxyHeaders;
      }

      drafts.push({
        url: finalUrl,
        behaviorHints: {
          notWebReady: !!proxyHdrs,
          bingeGroup: 'wavewatch',
          ...(proxyHdrs ? { proxyHeaders: { request: proxyHdrs } } : {}),
        },
        _meta: {
          quality: wv.quality,
          language: wv.language,
          source: 'wavewatch',
          server: wv.server,
        },
      });
    }

    // Process NetMirror results (netfree multi-audio HLS master). MUST go through
    // the LOCAL proxy: the segment token is IP-bound to the fetcher and the .jpg
    // segments need the local transformer -> video/mp2t. One adaptive stream per
    // platform; the player picks the audio track (VO + VF when available).
    // NetMirror ne peut être livré QUE par le proxy LOCAL (manifeste reconstruit +
    // segments .jpg->TS ; MediaFlow incapable). Déjà écarté en amont si le proxy local
    // n'est pas autorisé (localProxyAllowed) -> netmirrorResults est vide dans ce cas.
    for (const r of netmirrorResults) {
      // UNE ENTRÉE PAR QUALITÉ réellement présente (au lieu d'un master adaptatif unique).
      // Chaque entrée porte une vraie résolution -> le filtre d'exclusion de qualité et le
      // tri par qualité s'appliquent naturellement, et l'utilisateur choisit sa résolution.
      // L'audio (VF+VO) et les sous-titres restent dans CHAQUE entrée (le player bascule la
      // piste) : le master reconstruit avec un seul `q` embarque quand même toutes les pistes.
      for (const q of r.qualities) {
        const mu = new URL('/netmirror/master.m3u8', nmSegBase(req));
        mu.searchParams.set('h', r.cdnHost);
        mu.searchParams.set('id', r.contentId);
        mu.searchParams.set('p', r.prefix);
        mu.searchParams.set('n', String(r.segments));
        mu.searchParams.set('d', r.avgDur.toFixed(3));
        mu.searchParams.set('q', q); // une seule résolution par entrée
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
            bingeGroup: `netmirror-${r.platform}-${q}`, // binge par plateforme + qualité
          },
          _meta: {
            quality: q,
            language: r.language,
            source: 'netmirror',
            platform: r.platform,
          },
        });
      }
    }

    // Process StreamFlix results
    for (const sf of streamflixResults) {
      const d = await deliver(sf.url, {
        ...(sf.headers || {}), // Referer streamflix.mom (V2)
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, {}, req, config);

      if (!d) continue; // Skip blocked URLs

      drafts.push({
        url: d.url,
        behaviorHints: {
          notWebReady: !!d.proxyHeaders,
          bingeGroup: 'streamflix',
          ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
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
      const d = await deliver(wf.url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(wf.headers || {}), // l'UA spécifique de l'extracteur (ex. mobile pour luluvdo/tnmr) prime
      }, {}, req, config);

      if (!d) continue; // Skip blocked URLs

      drafts.push({
        url: d.url,
        behaviorHints: {
          notWebReady: !!d.proxyHeaders,
          bingeGroup: `wiflix-${wf.server}`,
          ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
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
      const d = await deliver(vd.url, {
        ...(vd.headers || {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, {}, req, config);

      if (!d) continue; // Skip blocked URLs

      drafts.push({
        url: d.url,
        behaviorHints: {
          notWebReady: !!d.proxyHeaders,
          bingeGroup: `voirdrama-${vd.server}`,
          ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
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
      const d = await deliver(va.url, {
        ...(va.headers || {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, {}, req, config);

      if (!d) continue; // Skip blocked URLs

      drafts.push({
        url: d.url,
        behaviorHints: {
          notWebReady: !!d.proxyHeaders,
          bingeGroup: `voiranime-${va.server}`,
          ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
        },
        _meta: {
          quality: va.quality,
          language: va.language,
          source: 'voiranime',
          server: va.server,
        },
      });
    }

    // Vostfree : anime VF/VOSTFR (principalement Sibnet mp4 direct).
    for (const vf of vostfreeResults) {
      const d = await deliver(vf.url, {
        ...(vf.headers || {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, {}, req, config);
      if (!d) continue;
      drafts.push({
        url: d.url,
        behaviorHints: {
          notWebReady: !!d.proxyHeaders,
          bingeGroup: `vostfree-${vf.server}`,
          ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
        },
        _meta: { quality: vf.quality, language: vf.language, source: 'vostfree', server: vf.server },
      });
    }

    // Process Nabistream results (dramas asiatiques VOSTFR — HLS master direct).
    // Les sous-titres NE sont PAS attachés au stream : ils sont servis via la
    // ressource /subtitles (handleSubtitles), seul mécanisme que Nuvio consomme.
    // Un double-listage (stream + ressource) faisait empiler les pistes.
    for (const nb of nabistreamResults) {
      const d = await deliver(nb.url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, { forceHls: true }, req, config);

      if (!d) continue; // Skip blocked URLs

      drafts.push({
        url: d.url,
        behaviorHints: {
          notWebReady: !!d.proxyHeaders,
          bingeGroup: 'nabistream',
          ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
        },
        _meta: {
          quality: nb.quality,
          language: nb.language,
          source: 'nabistream',
          subCount: nb.subtitles.length,
        },
      });
    }

    // nakastream : master HLS direct tokené (FR audio DEFAULT, token ~6h), Referer requis.
    for (const nk of nakastreamResults) {
      const d = await deliver(nk.url, { 'User-Agent': BROWSER_UA, 'Referer': 'https://nakastream.tv/' }, { forceHls: true }, req, config);
      if (!d) continue;
      drafts.push({
        url: d.url,
        behaviorHints: {
          notWebReady: !!d.proxyHeaders,
          bingeGroup: 'nakastream',
          ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
        },
        _meta: { quality: nk.quality, language: nk.language, source: 'nakastream', subCount: nk.subtitles.length },
      });
    }

    // Process Coflix results (films/séries FR VF+VOSTFR, HLS extrait des hôtes).
    for (const cf of coflixResults) {
      // livavid/tnmr : injouable en DIRECT (le player n'applique pas l'UA mobile aux
      // segments -> 302) ET via MEDIAFLOW (mangle les headers -> « Stream unavailable »).
      // SEUL le proxy LOCAL marche (forwarde l'UA exact). On ne l'offre donc qu'aux configs
      // qui peuvent l'utiliser (owner key / mode local) -> sinon flux mort, on l'écarte.
      // tnmr est anti-datacenter -> ne jouera de toute façon que sur un serveur résidentiel.
      const needsLocalProxy = /tnmr/i.test(cf.url);
      if (needsLocalProxy && !localProxyAllowed) continue;
      // UA par défaut D'ABORD, headers du stream ENSUITE : si l'extracteur a fixé un UA
      // précis (livavid = LULU_UA mobile), il gagne. Les hôtes sans UA (fsvid/vidzy)
      // gardent l'UA navigateur par défaut.
      const d = await deliver(cf.url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(cf.headers || {}),
      }, { forceHls: true, forceLocal: needsLocalProxy }, req, config);

      if (!d) continue; // Skip blocked URLs

      drafts.push({
        url: d.url,
        behaviorHints: {
          notWebReady: !!d.proxyHeaders,
          bingeGroup: `coflix-${cf.server}`,
          ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
        },
        _meta: {
          quality: cf.quality,
          language: cf.language,
          source: 'coflix',
          server: cf.server,
        },
      });
    }

    // Process AnimeSama results (anime VOSTFR/VF, HLS ansembed ou MP4 sibnet).
    // Le HLS ansembed (vmpx) a un token IP/ASN-bound -> non-directable (PROXY_FORCED).
    // Le MP4 sibnet : sa chaîne 302 est résolue côté extracteur -> URL finale directable
    // (sans header). Repassé en DIRECT le temps de re-tester sur ligne stable (un souci
    // de ligne cliente peut avoir mimé le « buffer après 2s »). Réintégrable au proxy
    // via PREFER_PROXY_HOSTS si le peering russe rame vraiment.
    for (const as of animesamaResults) {
      const isHls = /\.m3u8/i.test(as.url);
      const d = await deliver(as.url, {
        ...(as.headers || {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, { forceHls: isHls }, req, config);

      if (!d) continue; // Skip blocked URLs (ex. vmpx en mode direct : non-directable)

      drafts.push({
        url: d.url,
        behaviorHints: {
          notWebReady: !!d.proxyHeaders,
          bingeGroup: `animesama-${as.language}`,
          ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
        },
        _meta: {
          quality: as.quality,
          language: as.language,
          source: 'animesama',
        },
      });
    }

    // Process Videasy results (agrégateur VO anglais + sous-titres). HLS header-gaté
    // (segments .m4s sur emberforge, 403 sans Referer) -> doit passer par un PROXY, mais
    // celui DU MODE (forceProxy), pas forcément le local : en MFP -> MediaFlow, en local
    // -> proxy local, en direct pur -> écarté. Ça évite la fuite « proxy local » quand
    // seul MFP/direct est autorisé. (Le MP4 progressif éventuel reste directable.)
    for (const vd of videasyResults) {
      const isHls = /\.m3u8/i.test(vd.url);
      const d = await deliver(vd.url, {
        ...(vd.headers || {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, isHls ? { forceHls: true, forceProxy: true } : { forceHls: false }, req, config);

      if (!d) continue; // Skip blocked URLs

      drafts.push({
        url: d.url,
        behaviorHints: {
          notWebReady: !!d.proxyHeaders,
          bingeGroup: `videasy-${vd.server}`,
          ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
        },
        _meta: {
          quality: vd.quality,
          language: vd.language,
          source: 'videasy',
          server: vd.server,
          subCount: (vd.subtitles || []).length,
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
      let proxyHdrs: Record<string, string> | undefined; // posé si livraison directe

      const mfUrl = config?.mfUrl || DEFAULT_MEDIAFLOW_URL;
      const isMediaFlowUrl = mfUrl && fr.url.includes(new URL(mfUrl).hostname);

      if (isMediaFlowUrl) {
        finalUrl = fr.url;
      } else {
        const proxyHeaders: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...fr.headers,
        };
        const d = await deliver(fr.url, proxyHeaders, {}, req, config);
        if (!d) continue;
        finalUrl = d.url;
        proxyHdrs = d.proxyHeaders;
      }

      drafts.push({
        url: finalUrl,
        behaviorHints: {
          notWebReady: !!proxyHdrs,
          bingeGroup: 'frenchstream',
          ...(proxyHdrs ? { proxyHeaders: { request: proxyHdrs } } : {}),
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
      record(0, 'empty');
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
    // Ne jamais laisser OpenSubtitles retarder la liste : cap à 2,5s (sinon 0 -> pas
    // de badge). En pratique la promesse a tourné pendant tout le fan-out -> déjà prête.
    const frSubs = await Promise.race([
      frSubsPromise,
      new Promise<any[]>(resolve => setTimeout(() => resolve([]), 2500)),
    ]);
    const frSubCount = frSubs.length;
    const streams: StreamWithMeta[] = drafts.map(d => {
      // Videasy = agrégateur anglophone : son audio « VO » est TOUJOURS anglais (le
      // flux ne porte aucune langue). Pour le drapeau, sa vraie langue d'origine est
      // donc l'anglais, pas celle de TMDB — sinon on colle « 🇯🇵 VO » sur un doublage
      // anglais (ex. anime). On force 'en' pour ces flux uniquement.
      const streamOrigLang = d._meta.source === 'videasy' ? 'en' : info.originalLanguage;
      const filename = buildFilename({
        title: sceneMeta.title,
        year: sceneMeta.year,
        isSeries: type === 'series',
        season: parsed.season,
        episode: parsed.episode,
        lang: d._meta.language,
        originalLanguage: streamOrigLang,
        resolution: d._meta.quality,
        codec: d._meta.codec,
        provider: providerLabel(d._meta.source),
      });
      const delivery = computeDelivery(d.url, !!d.behaviorHints?.proxyHeaders, config);
      const meta = { ...d._meta, delivery, frSubCount };
      return {
        ...d,
        behaviorHints: { ...d.behaviorHints, filename },
        name: buildStreamName(meta),
        title: buildStreamTitle(meta, streamOrigLang, filename),
      };
    });

    // Apply user preferences (filter + sort)
    const sortedStreams = filterAndSortStreams(streams, config);

    // Remove _meta before sending to Stremio (internal use only)
    const cleanStreams = sortedStreams.map(({ _meta, ...rest }) => rest);

    // Ventilation par source sur les flux RÉELLEMENT renvoyés (post-filtrage), pour
    // que la somme colle au total. Dynamique : toutes les sources présentes, triées
    // par nombre décroissant — plus de liste figée sur 3 scrapers.
    const bySource = new Map<string, number>();
    for (const s of sortedStreams) {
      const src = s._meta?.source || 'inconnu';
      bySource.set(src, (bySource.get(src) || 0) + 1);
    }
    const breakdown = [...bySource.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([src, n]) => `${src}: ${n}`)
      .join(', ');

    // nakastream déconnecté (token 401) : entrée informative NON-bloquante en fin de liste,
    // qui ouvre le configure pré-rempli pour reconnecter. Les autres flux restent normaux.
    const outStreams: any[] = cleanStreams;
    if (nakastreamAuthFailed) {
      const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
      const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
      const cfgParam = (req.params as { config?: string }).config;
      const cfgUrl = cfgParam ? `${proto}://${host}/${cfgParam}/configure` : `${proto}://${host}/configure`;
      outStreams.push({ name: 'nakastream ⚠️', title: 'nakastream déconnecté\nReconnecte-le dans la configuration.', externalUrl: cfgUrl });
    }

    console.log(`[Stream] Returning ${cleanStreams.length} streams${breakdown ? ` (${breakdown})` : ''}`);
    record(cleanStreams.length, cleanStreams.length > 0 ? 'ok' : 'empty');
    res.json({ streams: outStreams });
  } catch (e) {
    console.error('[Stream] Error:', e);
    record(0, 'error');
    res.json({ streams: [] });
  }
}

// Stream endpoint (without config - uses env defaults)
app.get('/stream/:type/:id.json', async (req, res) => {
  if (accessEnabled()) return res.status(401).send("Non autorisé : clé d'accès requise");
  const { type, id } = req.params;
  await runWithLogCapture(pseudoLabel(null), () => handleStream(req, res, type, id, null));
});

// Stream endpoint (with config)
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const { config, type, id } = req.params;
  const userConfig = parseConfig(config);
  if (!userConfig) {
    return res.status(400).json({ error: 'Invalid configuration' });
  }
  if (denyIfNoAccess(userConfig, res)) return;
  await runWithLogCapture(pseudoLabel(userConfig?.pseudo), () => handleStream(req, res, type, id, userConfig));
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

    // nakastream : sous-titres FR/EN (WebVTT) tokénés (~6h), servis en direct (opt-in).
    // Re-résolus frais ; NakastreamAuthError -> juste ignoré ici (pas de subs, non-bloquant).
    if (config?.nakastreamToken) {
      try {
        const nks = await getNakastreamStreams(config.nakastreamToken, info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, info.title);
        (nks[0]?.subtitles || []).forEach((s, i) => {
          subtitles.push({ id: `nakastream-${i}-${s.lang}`, url: s.url, lang: s.lang });
        });
      } catch (e: any) {
        console.log('[Subtitles] Nakastream:', (e?.message || '').slice(0, 80));
      }
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

    // Videasy : sous-titres .vtt (VO anglais + autres langues si dispo, dont FR ->
    // VOSTFR), servis via /videasy/subtitle (ajoute le Referer, sert text/vtt).
    try {
      const vds = await getVideasyStreams(info.tmdbId, type as 'movie' | 'series', parsed.season, parsed.episode, config?.tmdbKey || DEFAULT_TMDB_KEY);
      const seenLang = new Set<string>();
      for (const s of (vds[0]?.subtitles || [])) { // subs identiques entre serveurs
        if (seenLang.has(s.lang)) continue;
        seenLang.add(s.lang);
        const label = /^fr/i.test(s.lang) ? 'Français' : /^en/i.test(s.lang) ? 'English' : s.lang;
        const su = new URL(`/videasy/subtitle/${encodeURIComponent(label)}.vtt`, baseUrl);
        su.searchParams.set('u', s.url);
        subtitles.push({ id: `videasy-${s.lang}`, url: signUrl(su).toString(), lang: s.lang });
      }
    } catch (e: any) {
      console.log('[Subtitles] Videasy:', (e?.message || '').slice(0, 80));
    }

    // Sous-titres FR EXTERNES (OpenSubtitles legacy) — complètent les flux VO
    // (Videasy…) qui ne portent pas de FR. Toujours proposés ; ignorés sur du VF.
    try {
      if (info.imdbId) {
        const ext = await getFrenchSubtitles(
          info.imdbId,
          type === 'series' ? parsed.season : undefined,
          type === 'series' ? parsed.episode : undefined,
        );
        ext.forEach((s, i) => {
          const su = new URL('/extsub/subtitle', baseUrl);
          su.searchParams.set('url', s.url);
          subtitles.push({ id: `opensubtitles-fr-${i}`, url: signUrl(su).toString(), lang: 'fre' });
        });
      }
    } catch (e: any) {
      console.log('[Subtitles] OpenSubtitles:', (e?.message || '').slice(0, 80));
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
app.get('/api/videasy/endpoints', (req, res) => {
  const reload = req.query.reload === 'true';
  res.json({ ...(reload ? reloadVideasyEndpoints() : getVideasyEndpoints()), reloaded: reload });
});
app.get('/api/animesama/endpoints', (req, res) => {
  const reload = req.query.reload === 'true';
  res.json({ ...(reload ? reloadAnimesamaEndpoints() : getAnimesamaEndpoints()), reloaded: reload });
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
  { path: 'videasy', file: 'videasy-endpoints.json', reload: reloadVideasyEndpoints },
  { path: 'animesama', file: 'animesama-endpoints.json', reload: reloadAnimesamaEndpoints },
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
  res.json({ domains: getAllowedDomains(), autoWhitelist: autoWhitelistEnabled() });
});
app.post('/api/whitelist', requireAdminSession, jsonBody, (req, res) => {
  const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim().toLowerCase() : '';
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return res.status(400).json({ ok: false, error: 'domaine invalide' });
  }
  const added = addAllowedDomain(domain);
  return res.json({ ok: true, added, domains: getAllowedDomains() });
});

// Réglages runtime (Paramétrage > Partage). GET non sensible (aucune clé en clair,
// cf. settingsView) ; POST derrière la session admin. Applique à chaud : mode,
// autoWhitelist et ownerKey sont relus par leurs getters à chaque usage.
app.get('/api/settings', (_req, res) => {
  // accessKeyConfigured : ACCESS_KEY est gérée uniquement dans le .env (garde
  // l'accès) ; l'admin l'affiche en lecture seule, jamais sa valeur.
  res.json({ ...settingsView(), accessKeyConfigured: accessEnabled(), netfreePool: poolStatus() });
});
app.post('/api/settings', requireAdminSession, jsonBody, (req, res) => {
  const b = req.body || {};
  const patch: { mode?: string | null; ownerKey?: string | null; autoWhitelist?: boolean | null; netfreeSocksPool?: boolean | null; captureAllLogs?: boolean | null; cacheMultStreams?: number | null; cacheMultNetmirror?: number | null; cacheMultEmpty?: number | null } = {};

  if ('mode' in b) {
    if (b.mode === null) patch.mode = null;
    else if (typeof b.mode === 'string') {
      // valide : sous-ensemble de {DIRECT,MFP,LOCAL} séparé par ; ou ,
      const toks = b.mode.split(/[;,]/).map((s: string) => s.trim().toLowerCase()).filter(Boolean);
      if (!toks.length || !toks.every((t: string) => t in MODE_ALIAS)) {
        return res.status(400).json({ ok: false, error: 'mode invalide (DIRECT/MFP/LOCAL)' });
      }
      // Normalise vers les libellés canoniques via MODE_ALIAS (direct/mediaflow/local),
      // puis re-affiche en étiquettes utilisateur.
      const LABEL: Record<string, string> = { direct: 'DIRECT', mediaflow: 'MFP', local: 'LOCAL' };
      patch.mode = [...new Set(toks.map((t: string) => LABEL[MODE_ALIAS[t]]))].join(';');
    }
  }
  if ('autoWhitelist' in b) {
    if (b.autoWhitelist === null) patch.autoWhitelist = null;
    else if (typeof b.autoWhitelist === 'boolean') patch.autoWhitelist = b.autoWhitelist;
    else return res.status(400).json({ ok: false, error: 'autoWhitelist doit être un booléen' });
  }
  if ('ownerKey' in b) {
    if (b.ownerKey === null || b.ownerKey === '') patch.ownerKey = null;
    else if (typeof b.ownerKey === 'string' && b.ownerKey.length >= 8 && b.ownerKey.length <= 128) {
      patch.ownerKey = b.ownerKey;
    } else return res.status(400).json({ ok: false, error: 'ownerKey : 8 à 128 caractères' });
  }
  if ('netfreeSocksPool' in b) {
    if (b.netfreeSocksPool === null) patch.netfreeSocksPool = null;
    else if (typeof b.netfreeSocksPool === 'boolean') patch.netfreeSocksPool = b.netfreeSocksPool;
    else return res.status(400).json({ ok: false, error: 'netfreeSocksPool doit être un booléen' });
  }
  if ('captureAllLogs' in b) {
    if (b.captureAllLogs === null) patch.captureAllLogs = null;
    else if (typeof b.captureAllLogs === 'boolean') patch.captureAllLogs = b.captureAllLogs;
    else return res.status(400).json({ ok: false, error: 'captureAllLogs doit être un booléen' });
  }
  for (const k of ['cacheMultStreams', 'cacheMultNetmirror', 'cacheMultEmpty'] as const) {
    if (k in b) {
      if (b[k] === null) patch[k] = null;
      else if (typeof b[k] === 'number' && b[k] > 0) patch[k] = b[k];
      else return res.status(400).json({ ok: false, error: `${k} doit être un nombre > 0 (borné 0.25–8)` });
    }
  }

  updateSettings(patch);
  // Applique le toggle du pool À CHAUD (démarre/arrête le scan en fond).
  if ('netfreeSocksPool' in b) setPoolEnabled(netfreeSocksPoolEnabled());
  return res.json({ ok: true, ...settingsView(), netfreePool: poolStatus() });
});

// ── Cache : stats + purge manuelle ─────────────────────────────────────────────
// GET  /api/cache        → stats (entrées vivantes par scope, taille, hit rate).
// POST /api/cache/clear  → vide tout, ou un scope précis ({ scope: 'movix' }).
app.get('/api/cache', (_req, res) => {
  res.json(getCacheStats());
});
app.post('/api/cache/clear', requireAdminSession, jsonBody, (req, res) => {
  const scope = (req.body || {}).scope;
  if (scope !== undefined && (typeof scope !== 'string' || !scope)) {
    return res.status(400).json({ ok: false, error: 'scope doit être une chaîne non vide (ou absent pour tout vider)' });
  }
  const removed = scope ? clearScope(scope) : clearAll();
  console.log(`[Cache] Vidé ${scope ? `scope "${scope}"` : 'TOUT'} depuis l'admin : ${removed} entrées`);
  return res.json({ ok: true, scope: scope || null, removed });
});

// ── Contrôle des sources : santé (metrics) + état activé/désactivé ──────────────
// GET : une entrée par source avec statut, fenêtre 20 (recent) et enabled. POST : toggle.
app.get('/api/sources', (_req, res) => {
  const metrics = getAllMetrics();
  const disabled = getDisabledSources();
  const sources = Object.entries(metrics).map(([name, m]) => ({ name, enabled: !disabled.includes(name), ...m }));
  const on = sources.filter(s => s.enabled);
  res.json({
    sources,
    summary: {
      total: sources.length,
      ok: on.filter(s => s.status === 'ok').length,
      warning: on.filter(s => s.status === 'warning').length,
      down: on.filter(s => s.status === 'down').length,
      off: sources.length - on.length,
    },
  });
});
app.post('/api/sources/:name', requireAdminSession, jsonBody, (req, res) => {
  const name = String(req.params.name || '');
  if (!Object.keys(getAllMetrics()).includes(name)) return res.status(404).json({ ok: false, error: 'source inconnue' });
  const enabled = (req.body || {}).enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'enabled doit être un booléen' });
  const set = new Set(getDisabledSources());
  if (enabled) set.delete(name); else set.add(name);
  updateSettings({ disabledSources: [...set] });
  return res.json({ ok: true, name, enabled });
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

// Modes de livraison proposés (pilotés par MODE du .env) — lu par /configure.
// Une `ownerKey` valide en query débloque les 3 modes (le propriétaire garde le
// proxy local même si MODE le restreint pour les partages). `ownerKeyRequired`
// indique à l'UI d'afficher le champ (seulement si OWNER_KEY est configurée).
app.get('/api/modes', (req, res) => {
  const isOwner = ownerKeyMatches(req.query.ownerKey);
  const modes = isOwner ? ['direct', 'mediaflow', 'local'] : allowedModes();
  res.json({ modes, default: modes[0], owner: isOwner, ownerKeyAvailable: ownerKeyEnabled() });
});

// Pairing nakastream (public, support configure) : l'utilisateur génère un code sur
// nakastream.tv, le colle dans le wizard ; on l'échange ici côté serveur (pas de CORS)
// contre un token de session device. Le token ne transite qu'en réponse (jamais loggué).
app.post('/api/nakastream/claim', jsonBody, async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{4,12}$/.test(code)) { res.status(400).json({ ok: false, error: 'Code invalide' }); return; }
  const base = getNakastreamEndpoints().base.replace(/\/+$/, '');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, status } = await axios.post(`${base}/api/v1/auth/pair/claim`, { code }, {
        headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA, 'Origin': base, 'Referer': `${base}/` },
        timeout: 12000, validateStatus: () => true,
      });
      const token = data?.token;
      if (status >= 200 && status < 300 && typeof token === 'string' && token.length >= 10) {
        res.json({ ok: true, token });
      } else {
        res.status(400).json({ ok: false, error: data?.message || 'Code invalide ou expiré.' });
      }
      return;
    } catch (e: any) {
      const dns = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT/.test(String(e?.code || e?.message || ''));
      if (dns && attempt === 0) { await new Promise(r => setTimeout(r, 600)); continue; }
      res.status(502).json({ ok: false, error: 'nakastream injoignable, réessaie.' });
      return;
    }
  }
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

// Logs live pour l'admin — lit le ring mémoire (secrets déjà masqués à l'écriture).
app.get('/api/logs', requireAdminSession, (req, res) => {
  const num = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : undefined);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  res.json(getLogs({
    sinceSeq: num(req.query.sinceSeq),
    source: str(req.query.source),
    level: str(req.query.level),
    q: str(req.query.q),
    limit: num(req.query.limit),
  }));
});

// Tracking Users (admin). Vue d'ensemble triée (problèmes récents en tête), requêtes d'un
// pseudo, et trace de logs détaillée d'une requête (chargée au clic). `/request/:id` déclaré
// AVANT `/:pseudo` sinon "request" serait capturé comme un pseudo.
app.get('/api/users', requireAdminSession, (_req, res) => {
  res.json({ users: getUsersOverview() });
});
app.get('/api/users/request/:id', requireAdminSession, (req, res) => {
  res.json({ log: getRequestLog(Number(req.params.id)) });
});
app.get('/api/users/:pseudo', requireAdminSession, (req, res) => {
  res.json({ requests: getUserRequests(req.params.pseudo) });
});
// Supprime un utilisateur : toute son activité + libère son pseudo (re-revendicable ensuite).
app.delete('/api/users/:pseudo', requireAdminSession, (req, res) => {
  const pseudo = String(req.params.pseudo || '');
  if (!pseudo) return res.status(400).json({ ok: false, error: 'pseudo manquant' });
  const removed = deleteUser(pseudo);
  console.log(`[Admin] Utilisateur supprimé: "${pseudo}" (${removed} requête(s))`);
  return res.json({ ok: true, pseudo, removed });
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

  // WaveWatch : le resolver zeus.php sert la page player (200 + <title>) pour un tmdbId connu.
  const wwStart = Date.now();
  try {
    const resp = await probeGet('https://apis.wavewatch.top/zeus.php?type=movie&id=550', {
      timeout: 10000, validateStatus: (s: number) => s < 500,
    });
    const ok = resp.status === 200 && /<title/i.test(String(resp.data || ''));
    results.wavewatch = { status: ok ? 'up' : 'degraded', latency: Date.now() - wwStart };
  } catch (e: any) {
    results.wavewatch = { status: 'down', error: e.message };
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
// Videasy : sous-titre .vtt sur le CDN rotatif (moon/premiumvacations/winterforest…).
// Anti-SSRF : chemin Videasy `/vd/.../subs/*.vtt` + hôte autorisé + pas d'IP privée
// (isAllowedUrl). Ajoute le Referer player.videasy.to (exigé par le CDN).
app.get('/videasy/subtitle/:label', async (req, res) => {
  const u = String(req.query.u || '');
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:' || !/\/vd\/.+\/subs\/.+\.vtt$/i.test(parsed.pathname) || !isAllowedUrl(u).allowed) {
      res.status(404).end();
      return;
    }
    const resp = await axios.get(u, { responseType: 'text', timeout: 15000, transformResponse: v => v, headers: { Referer: 'https://player.videasy.to/' } });
    let vtt = String(resp.data).replace(/\r+/g, '');
    if (!/^﻿?WEBVTT/.test(vtt)) vtt = 'WEBVTT\n\n' + vtt;
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(vtt);
  } catch {
    res.status(502).end();
  }
});

// Sous-titres FR externes (OpenSubtitles legacy) : télécharge le SRT (gzippé),
// gunzip, convertit SRT->VTT, sert text/vtt. SSRF : uniquement *.opensubtitles.org.
app.get('/extsub/subtitle', async (req, res) => {
  const u = String(req.query.url || '');
  let parsed: URL;
  try { parsed = new URL(u); } catch { res.status(400).end(); return; }
  if (parsed.protocol !== 'https:' || !/(^|\.)opensubtitles\.org$/i.test(parsed.hostname)) {
    res.status(403).end();
    return;
  }
  try {
    const resp = await axios.get<ArrayBuffer>(u, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'LooStream/1.0 (+subtitles)' },
      maxContentLength: 5 * 1024 * 1024, maxBodyLength: 5 * 1024 * 1024,
    });
    let buf = Buffer.from(resp.data);
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch { /* pas gzip */ } }
    // Décodage : UTF-8 par défaut ; si caractères de remplacement (fréquent sur les
    // .srt/.ass FR encodés en Windows-1252), on retente en 1252.
    let text = buf.toString('utf-8');
    if (text.includes('�')) { try { text = new TextDecoder('windows-1252').decode(buf); } catch { /* garde utf-8 */ } }
    // SRT -> VTT (existant) OU ASS/SSA -> VTT (anime). Détection au contenu.
    const vtt = subtitleToVtt(text);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(vtt);
  } catch {
    res.status(502).end();
  }
});

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
  // Pool SOCKS netfree : démarre le scan en fond s'il est activé (persisté). OFF = résidentiel.
  if (netfreeSocksPoolEnabled()) { console.log('[NetfreePool] activé au démarrage'); setPoolEnabled(true); }
});

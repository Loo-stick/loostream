import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { cached } from '../cache';

// CinemaOS (cinemaos.live) — TMDB-keyed meta-aggregator over ~20 upstream providers.
// Reproduces its client protocol server-side (no Cloudflare block, no browser):
//   secret = HMAC_SHA256(secondary, HMAC_SHA256(primary, "tmdbId:..|imdbId:..|seasonId:..|episodeId:.."))
//   GET /api/providerv4/scrape?<params>&secret&_gt&scraper=<id>   (header x-c4os-auth: <_gt>)
//   response { data: { encrypted, cin, mao, salt? } } -> AES-256-GCM decrypt -> { sources, captions }
// Keys/token live in config/cinemaos.json (hot-reloaded) so they can be rotated without a rebuild.

export interface CinemaosConfig {
  base: string;
  primaryKey: string;
  secondaryKey: string;
  encKey: string;
  gt: string;
  scrapers: string[];
}

const CONFIG_PATH = process.env.CINEMAOS_CONFIG || path.join(process.cwd(), 'config', 'cinemaos.json');

let cfg: CinemaosConfig = loadFromDisk();

function loadFromDisk(): CinemaosConfig {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return {
    base: raw.base || 'https://cinemaos.live',
    primaryKey: raw.primaryKey,
    secondaryKey: raw.secondaryKey,
    encKey: raw.encKey,
    gt: raw.gt,
    scrapers: Array.isArray(raw.scrapers) ? raw.scrapers : [],
  };
}

export function loadCinemaosConfig(): CinemaosConfig {
  return cfg;
}

export function reloadCinemaosConfig(): CinemaosConfig {
  cfg = loadFromDisk();
  console.log(`[CinemaOS] Config reloaded (${cfg.scrapers.length} scrapers)`);
  return cfg;
}

try {
  const watcher = fs.watch(path.dirname(CONFIG_PATH), (_e, f) => {
    if (f === 'cinemaos.json') {
      try { reloadCinemaosConfig(); } catch (e: any) { console.log(`[CinemaOS] reload failed: ${e.message}`); }
    }
  });
  watcher.unref(); // don't keep the process alive on the watcher alone
} catch { /* watch is best-effort */ }

// secret = HMAC_SHA256(secondary, HMAC_SHA256(primary, canonical))
export function signSecret(m: { tmdbId?: string; imdbId?: string; season?: string; episode?: string }): string {
  const parts: string[] = [];
  if (m.tmdbId) parts.push(`tmdbId:${m.tmdbId}`);
  if (m.imdbId) parts.push(`imdbId:${m.imdbId}`);
  if (m.season) parts.push(`seasonId:${m.season}`);
  if (m.episode) parts.push(`episodeId:${m.episode}`);
  const canon = parts.join('|');
  const r = crypto.createHmac('sha256', cfg.primaryKey).update(canon).digest('hex');
  return crypto.createHmac('sha256', cfg.secondaryKey).update(r).digest('hex');
}

// AES-256-GCM decrypt of the providerv4 `data` object.
export function decryptData(o: { encrypted: string; cin: string; mao: string; salt?: string; version?: number; useKeyDerivation?: boolean }): any {
  const d = Buffer.from(o.encrypted, 'hex');
  const iv = Buffer.from(o.cin, 'hex');
  const tag = Buffer.from(o.mao, 'hex');
  const salt = o.salt ? Buffer.from(o.salt, 'hex') : crypto.createHash('sha256').update(iv).digest().slice(0, 32);
  const useKD = !(o.useKeyDerivation === false || (o.version !== undefined && !(o.version >= 1)));
  const key = useKD ? crypto.pbkdf2Sync(cfg.encKey, salt, 100000, 32, 'sha256') : Buffer.from(cfg.encKey, 'hex');
  const dc = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dc.setAuthTag(tag);
  return JSON.parse(Buffer.concat([dc.update(d), dc.final()]).toString('utf8'));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;

export interface CinemaosSubtitle { url: string; lang: string; }
export interface CinemaosStream {
  quality: string;   // '4K' | '1080p' | '720p' | 'HD'
  url: string;       // direct HLS m3u8 (worker-unwrapped when applicable)
  referer: string;   // header the CDN needs (may be '')
  language: string;  // 'English' | 'Original' | 'Hindi' | ... | 'VO'
  server: string;    // e.g. 'Vidzee/Vega'
  subtitles: CinemaosSubtitle[];
}

function mapQuality(bitrate?: string): string {
  const b = String(bitrate || '').toLowerCase();
  if (b.includes('4k') || b.includes('2160')) return '4K';
  if (b.includes('fhd') || b.includes('1080')) return '1080p';
  if (b.includes('hd') && !b.includes('fhd')) return '720p';
  return 'HD';
}

// play.cinemaos.workers.dev/api/proxy?url=<enc>&referer=<enc> -> unwrap to the real CDN url.
function unwrapWorker(u: string): { url: string; referer: string } {
  try {
    const parsed = new URL(u);
    if (parsed.hostname.endsWith('cinemaos.workers.dev') && parsed.searchParams.get('url')) {
      return { url: parsed.searchParams.get('url')!, referer: parsed.searchParams.get('referer') || '' };
    }
  } catch { /* fall through */ }
  return { url: u, referer: '' };
}

// ISO-639 best effort from a caption's language / languageName.
function toLang(language?: string, languageName?: string): string {
  const s = `${language || ''} ${languageName || ''}`.toLowerCase();
  if (/fran|french|français/.test(s)) return 'fre';
  if (/english|anglais/.test(s)) return 'eng';
  if (/arab/.test(s)) return 'ara';
  if (/span|espa/.test(s)) return 'spa';
  if (/germ|deutsch/.test(s)) return 'ger';
  if (/ital/.test(s)) return 'ita';
  if (/port/.test(s)) return 'por';
  if (/hind/.test(s)) return 'hin';
  return (language || languageName || 'und').slice(0, 3).toLowerCase();
}

interface DecodedSource { url?: string; type?: string; language?: string; bitrate?: string; headers?: Record<string, string>; server?: string; }
interface DecodedResp { name?: string; sources?: Record<string, DecodedSource>; captions?: Array<{ language?: string; languageName?: string; url?: string }>; }

async function scrapeOne(meta: Record<string, string>, scraperId: string): Promise<{ streams: CinemaosStream[] } | null> {
  const c = loadCinemaosConfig();
  const params = new URLSearchParams({
    ...meta,
    secret: signSecret({ tmdbId: meta.tmdbId, imdbId: meta.imdbId, season: meta.seasonId, episode: meta.episodeId }),
    _gt: c.gt,
    scraper: scraperId,
  });
  try {
    const { data } = await axios.get(`${c.base}/api/providerv4/scrape?${params.toString()}`, {
      headers: { 'User-Agent': UA, 'x-c4os-auth': c.gt, 'Referer': `${c.base}/movie/watch/${meta.tmdbId}` },
      timeout: REQ_TIMEOUT_MS,
    });
    if (!data || !data.data || !data.data.encrypted) return null;
    const dec: DecodedResp = decryptData(data.data);
    const sources = dec.sources || {};

    const subs: CinemaosSubtitle[] = [];
    const seenLang = new Set<string>();
    for (const cap of dec.captions || []) {
      if (!cap.url) continue;
      const lang = toLang(cap.language, cap.languageName);
      if (seenLang.has(lang)) continue;
      seenLang.add(lang);
      subs.push({ url: cap.url, lang });
    }

    const streams: CinemaosStream[] = [];
    for (const [serverName, s] of Object.entries(sources)) {
      if (!s || !s.url || String(s.type || 'hls') !== 'hls') continue;
      const { url, referer } = unwrapWorker(s.url);
      streams.push({
        quality: mapQuality(s.bitrate),
        url,
        referer: referer || s.headers?.Referer || s.headers?.referer || '',
        language: s.language || 'VO',
        server: `${dec.name || scraperId}/${serverName}`,
        subtitles: subs,
      });
    }
    return { streams };
  } catch (e: any) {
    console.log(`[CinemaOS] scraper ${scraperId} failed: ${(e.message || '').slice(0, 100)}`);
    return null;
  }
}

export async function getCinemaosStreams(
  tmdbId: string, imdbId: string, mediaType: 'movie' | 'series',
  title: string, year: string, season?: number, episode?: number
): Promise<CinemaosStream[]> {
  if (!tmdbId || !imdbId) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const key = mediaType === 'series'
    ? `cinemaos:series:${tmdbId}:${season}:${episode}`
    : `cinemaos:movie:${tmdbId}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchCinemaos(tmdbId, imdbId, mediaType, title, year, season, episode),
    { scope: 'cinemaos', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchCinemaos(
  tmdbId: string, imdbId: string, mediaType: 'movie' | 'series',
  title: string, year: string, season?: number, episode?: number
): Promise<CinemaosStream[]> {
  const c = loadCinemaosConfig();
  const meta: Record<string, string> = { type: mediaType === 'series' ? 'tv' : 'movie', tmdbId, imdbId, t: title, ry: year };
  if (mediaType === 'series') { meta.seasonId = String(season); meta.episodeId = String(episode); }

  const results = await Promise.all(c.scrapers.map(id => scrapeOne(meta, id)));
  const streams = results.filter((r): r is { streams: CinemaosStream[] } => !!r).flatMap(r => r.streams);

  const seen = new Set<string>();
  const deduped = streams.filter(s => (seen.has(s.url) ? false : (seen.add(s.url), true)));
  if (deduped.length === 0) { console.log(`[CinemaOS] No streams for "${title}" (${year})`); return []; }
  console.log(`[CinemaOS] "${title}" -> ${deduped.length} stream(s): ${deduped.map(s => `${s.server}[${s.quality}/${s.language}]`).slice(0, 8).join(', ')}`);
  return deduped;
}

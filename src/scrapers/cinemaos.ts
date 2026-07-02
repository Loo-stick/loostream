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

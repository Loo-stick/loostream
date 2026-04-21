import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const CACHE_PATH = process.env.CACHE_DB_PATH ||
  (fs.existsSync('/app/config')
    ? '/app/config/cache.db'
    : path.join(process.cwd(), 'config', 'cache.db'));

fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });

const db = new Database(CACHE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    scope TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
  CREATE INDEX IF NOT EXISTS idx_cache_scope ON cache(scope);
`);

const getStmt = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?');
const incHitStmt = db.prepare('UPDATE cache SET hits = hits + 1 WHERE key = ?');
const setStmt = db.prepare(
  'INSERT OR REPLACE INTO cache (key, value, expires_at, created_at, hits, scope) VALUES (?, ?, ?, ?, 0, ?)'
);
const delStmt = db.prepare('DELETE FROM cache WHERE key = ?');
const purgeStmt = db.prepare('DELETE FROM cache WHERE expires_at < ?');
const countStmt = db.prepare('SELECT COUNT(*) as n FROM cache WHERE expires_at >= ?');
const byScopeStmt = db.prepare(
  'SELECT scope, COUNT(*) as n FROM cache WHERE expires_at >= ? GROUP BY scope'
);

const runtimeStats = { hits: 0, misses: 0 };

export function get<T = any>(key: string): T | null {
  const row = getStmt.get(key) as { value: string; expires_at: number } | undefined;
  if (!row) {
    runtimeStats.misses++;
    return null;
  }
  if (row.expires_at < Date.now()) {
    delStmt.run(key);
    runtimeStats.misses++;
    return null;
  }
  runtimeStats.hits++;
  incHitStmt.run(key);
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function set(key: string, value: unknown, ttlMs: number, scope?: string): void {
  const now = Date.now();
  setStmt.run(key, JSON.stringify(value), now + ttlMs, now, scope || null);
}

export function del(key: string): void {
  delStmt.run(key);
}

export interface CachedOptions<T> {
  scope?: string;
  shouldCache?: (value: T) => boolean;
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  opts?: CachedOptions<T>
): Promise<T> {
  const hit = get<T>(key);
  if (hit !== null) return hit;

  const value = await fn();
  const shouldCache = opts?.shouldCache ?? (() => true);
  if (shouldCache(value)) {
    set(key, value, ttlMs, opts?.scope);
  }
  return value;
}

export function purgeExpired(): number {
  const result = purgeStmt.run(Date.now());
  return result.changes as number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  fileSizeBytes: number;
  liveEntries: number;
  byScope: Record<string, number>;
}

export function getCacheStats(): CacheStats {
  const total = runtimeStats.hits + runtimeStats.misses;
  const hitRate = total > 0 ? runtimeStats.hits / total : 0;
  const now = Date.now();
  const liveEntries = (countStmt.get(now) as { n: number }).n;
  const fileSizeBytes = fs.existsSync(CACHE_PATH) ? fs.statSync(CACHE_PATH).size : 0;
  const rows = byScopeStmt.all(now) as { scope: string | null; n: number }[];
  const byScope: Record<string, number> = {};
  for (const { scope, n } of rows) byScope[scope || 'other'] = n;
  return { hits: runtimeStats.hits, misses: runtimeStats.misses, hitRate, fileSizeBytes, liveEntries, byScope };
}

const purgeTimer = setInterval(() => {
  const removed = purgeExpired();
  if (removed > 0) console.log(`[Cache] Purged ${removed} expired entries`);
}, 60 * 60 * 1000);
purgeTimer.unref();

console.log(`[Cache] Initialized at ${CACHE_PATH}`);

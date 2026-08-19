import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// Suivi d'activité par utilisateur (pseudo). Base dédiée (séparée de cache.db) — bind-montée
// dans config/ => survit au recreate. Append indexé + rétention 30 j => scale à l'échelle,
// aucune réécriture de fichier complet. Chaque requête stocke un résumé par source (detail)
// et, pour les problèmes (ou si captureAllLogs), la trace de logs brute (log).
const DB_PATH = process.env.USERS_DB ||
  (fs.existsSync('/app/config') ? '/app/config/users.db'
    : path.join(process.cwd(), 'config', 'users.db'));

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS user_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pseudo TEXT NOT NULL, media_type TEXT, content_id TEXT, title TEXT,
    streams INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL,
    detail TEXT, log TEXT, ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ua_pseudo ON user_activity(pseudo);
  CREATE INDEX IF NOT EXISTS idx_ua_ts ON user_activity(ts);
`);

// Migration : hash (court) de la clé TMDB du user -> identifie « le même utilisateur »
// pour l'unicité du pseudo (deux clés TMDB différentes ne peuvent pas partager un pseudo).
try { db.exec('ALTER TABLE user_activity ADD COLUMN key_hash TEXT'); } catch { /* déjà présente */ }

// Propriété d'un pseudo : le 1er (clé TMDB) à le REVENDIQUER le possède. Rempli à la
// génération du lien (configure) ET au stream (couvre les 80 users existants sans action).
// Une clé peut posséder plusieurs pseudos ; un pseudo n'appartient qu'à UNE clé. NOCASE.
db.exec(`CREATE TABLE IF NOT EXISTS pseudo_owner (
  pseudo TEXT COLLATE NOCASE PRIMARY KEY,
  key_hash TEXT NOT NULL,
  ts INTEGER NOT NULL
);`);
const ownerStmt = db.prepare('SELECT key_hash FROM pseudo_owner WHERE pseudo = ?');
const claimStmt = db.prepare('INSERT OR IGNORE INTO pseudo_owner (pseudo, key_hash, ts) VALUES (?, ?, ?)');

/** Revendique un pseudo pour une clé. Renvoie true si OK (libre ou déjà à cette clé),
 *  false s'il appartient à une AUTRE clé. Idempotent (INSERT OR IGNORE). */
export function claimPseudo(pseudo: string, keyHash: string): boolean {
  if (!pseudo || !keyHash) return true;
  claimStmt.run(pseudo, keyHash, Date.now()); // no-op si déjà revendiqué
  const owner = (ownerStmt.get(pseudo) as { key_hash?: string } | undefined)?.key_hash;
  return owner === keyHash;
}

const insertStmt = db.prepare(
  `INSERT INTO user_activity (pseudo, media_type, content_id, title, streams, outcome, detail, log, ts, key_hash)
   VALUES (@pseudo,@media_type,@content_id,@title,@streams,@outcome,@detail,@log,@ts,@key_hash)`
);

export interface ActivityInput {
  mediaType?: string; contentId?: string; title?: string;
  streams: number; outcome: 'ok' | 'empty' | 'error'; detail?: string; log?: string | null;
}

export function recordUserActivity(pseudo: string, e: ActivityInput, keyHash?: string): void {
  try {
    insertStmt.run({
      pseudo, media_type: e.mediaType ?? null, content_id: e.contentId ?? null,
      title: e.title ?? null, streams: e.streams | 0, outcome: e.outcome,
      detail: e.detail ?? null, log: e.log ? e.log.slice(0, 8192) : null, ts: Date.now(),
      key_hash: keyHash || null,
    });
    // Revendique le pseudo pour cette clé (couvre les users existants qui ne re-génèrent pas).
    if (keyHash && pseudo && pseudo !== '(anonyme)') claimPseudo(pseudo, keyHash);
  } catch (err: any) { console.error('[UserActivity] insert failed:', err.message); }
}

const overviewStmt = db.prepare(`
  SELECT pseudo, MAX(ts) lastSeen, COUNT(*) requests,
    SUM(outcome='empty') empties, SUM(outcome='error') errors,
    SUM((outcome IN ('empty','error')) AND ts > ?) recentProblems
  FROM user_activity GROUP BY pseudo
  ORDER BY recentProblems DESC, lastSeen DESC
`);
export function getUsersOverview() {
  return overviewStmt.all(Date.now() - 7 * 24 * 60 * 60 * 1000) as any[];
}

// Stats AGRÉGÉES tous utilisateurs (dashboard/admin). Sans session persistante, la vraie
// concurrence n'est pas mesurable -> « en ligne » = pseudos distincts actifs sur une courte
// fenêtre (ONLINE_WINDOW_MS), proxy honnête du « combien sont là en même temps ». Le pseudo
// '(anonyme)' (users sans pseudo, agrégat fourre-tout) est EXCLU des décomptes d'utilisateurs
// distincts mais reste dans le volume de requêtes/outcomes.
const ONLINE_WINDOW_MS = 10 * 60 * 1000;

const claimedCountStmt = db.prepare('SELECT COUNT(*) n FROM pseudo_owner');
const activityAggStmt = db.prepare(`
  SELECT
    COUNT(DISTINCT CASE WHEN pseudo != '(anonyme)' THEN pseudo END) distinctActive,
    COUNT(DISTINCT CASE WHEN pseudo != '(anonyme)' AND ts > @online THEN pseudo END) online,
    COUNT(DISTINCT CASE WHEN pseudo != '(anonyme)' AND ts > @d1 THEN pseudo END) active24h,
    COUNT(DISTINCT CASE WHEN pseudo != '(anonyme)' AND ts > @d7 THEN pseudo END) active7d,
    COUNT(DISTINCT CASE WHEN pseudo != '(anonyme)' AND ts > @d30 THEN pseudo END) active30d,
    COUNT(*) totalRequests,
    COALESCE(SUM(outcome='ok'),0) ok,
    COALESCE(SUM(outcome='empty'),0) empty,
    COALESCE(SUM(outcome='error'),0) error,
    COALESCE(SUM(media_type='movie'),0) movies,
    COALESCE(SUM(media_type='series'),0) series
  FROM user_activity
`);
const topTitlesStmt = db.prepare(`
  SELECT title, media_type mediaType, content_id contentId, COUNT(*) count
  FROM user_activity WHERE content_id IS NOT NULL
  GROUP BY content_id ORDER BY count DESC, MAX(ts) DESC LIMIT 10
`);

export interface UserStats {
  totalClaimed: number;                 // pseudos revendiqués (permanent, pseudo_owner)
  distinctActive: number;               // pseudos distincts sur la fenêtre de rétention (30 j)
  online: number;                       // actifs sur les ~10 dernières min (proxy « en même temps »)
  active24h: number; active7d: number; active30d: number;
  totalRequests: number;
  outcomes: { ok: number; empty: number; error: number };
  media: { movies: number; series: number };
  topTitles: { title: string | null; mediaType: string | null; contentId: string; count: number }[];
  onlineWindowMin: number;
  retentionDays: number;
}

export function getUserStats(): UserStats {
  const now = Date.now();
  const agg = activityAggStmt.get({
    online: now - ONLINE_WINDOW_MS,
    d1: now - 24 * 60 * 60 * 1000,
    d7: now - 7 * 24 * 60 * 60 * 1000,
    d30: now - 30 * 24 * 60 * 60 * 1000,
  }) as any;
  const claimed = (claimedCountStmt.get() as { n: number }).n;
  const top = topTitlesStmt.all() as any[];
  return {
    totalClaimed: claimed,
    distinctActive: agg.distinctActive,
    online: agg.online,
    active24h: agg.active24h, active7d: agg.active7d, active30d: agg.active30d,
    totalRequests: agg.totalRequests,
    outcomes: { ok: agg.ok, empty: agg.empty, error: agg.error },
    media: { movies: agg.movies, series: agg.series },
    topTitles: top.map(t => ({ title: t.title, mediaType: t.mediaType, contentId: t.contentId, count: t.count })),
    onlineWindowMin: ONLINE_WINDOW_MS / 60000,
    retentionDays: RETENTION_MS / (24 * 60 * 60 * 1000),
  };
}

const requestsStmt = db.prepare(
  `SELECT id, title, media_type mediaType, content_id contentId, streams, outcome, detail, ts
   FROM user_activity WHERE pseudo = ? ORDER BY ts DESC LIMIT ?`
);
// Unicité du pseudo : appartient-il à une clé TMDB DIFFÉRENTE ? (même clé = même user qui
// re-configure -> pas une collision). Lit la table de propriété (pseudo_owner).
export function isPseudoTakenByOther(pseudo: string, keyHash: string): boolean {
  if (!pseudo || !keyHash) return false;
  const owner = (ownerStmt.get(pseudo) as { key_hash?: string } | undefined)?.key_hash;
  return !!owner && owner !== keyHash;
}

export function getUserRequests(pseudo: string, limit = 20) {
  return requestsStmt.all(pseudo, limit) as any[];
}

const logStmt = db.prepare('SELECT log FROM user_activity WHERE id = ?');
export function getRequestLog(id: number): string | null {
  const r = logStmt.get(id) as { log: string | null } | undefined;
  return r?.log ?? null;
}

// Supprime TOUTE l'activité d'un pseudo + libère la propriété du pseudo (pseudo_owner, NOCASE ->
// re-revendicable ensuite par n'importe quelle clé). Renvoie le nb de lignes d'activité supprimées.
const delActivityStmt = db.prepare('DELETE FROM user_activity WHERE pseudo = ?');
const delOwnerStmt = db.prepare('DELETE FROM pseudo_owner WHERE pseudo = ?');
export function deleteUser(pseudo: string): number {
  if (!pseudo) return 0;
  const n = delActivityStmt.run(pseudo).changes;
  delOwnerStmt.run(pseudo);
  return n;
}

const purgeStmt = db.prepare('DELETE FROM user_activity WHERE ts < ?');
export function purgeOldActivity(): number {
  return purgeStmt.run(Date.now() - RETENTION_MS).changes;
}
setInterval(() => {
  const n = purgeOldActivity();
  if (n > 0) console.log(`[UserActivity] purged ${n} old rows`);
}, 6 * 60 * 60 * 1000).unref();

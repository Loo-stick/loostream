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

const insertStmt = db.prepare(
  `INSERT INTO user_activity (pseudo, media_type, content_id, title, streams, outcome, detail, log, ts)
   VALUES (@pseudo,@media_type,@content_id,@title,@streams,@outcome,@detail,@log,@ts)`
);

export interface ActivityInput {
  mediaType?: string; contentId?: string; title?: string;
  streams: number; outcome: 'ok' | 'empty' | 'error'; detail?: string; log?: string | null;
}

export function recordUserActivity(pseudo: string, e: ActivityInput): void {
  try {
    insertStmt.run({
      pseudo, media_type: e.mediaType ?? null, content_id: e.contentId ?? null,
      title: e.title ?? null, streams: e.streams | 0, outcome: e.outcome,
      detail: e.detail ?? null, log: e.log ? e.log.slice(0, 8192) : null, ts: Date.now(),
    });
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

const requestsStmt = db.prepare(
  `SELECT id, title, media_type mediaType, content_id contentId, streams, outcome, detail, ts
   FROM user_activity WHERE pseudo = ? ORDER BY ts DESC LIMIT ?`
);
export function getUserRequests(pseudo: string, limit = 20) {
  return requestsStmt.all(pseudo, limit) as any[];
}

const logStmt = db.prepare('SELECT log FROM user_activity WHERE id = ?');
export function getRequestLog(id: number): string | null {
  const r = logStmt.get(id) as { log: string | null } | undefined;
  return r?.log ?? null;
}

const purgeStmt = db.prepare('DELETE FROM user_activity WHERE ts < ?');
export function purgeOldActivity(): number {
  return purgeStmt.run(Date.now() - RETENTION_MS).changes;
}
setInterval(() => {
  const n = purgeOldActivity();
  if (n > 0) console.log(`[UserActivity] purged ${n} old rows`);
}, 6 * 60 * 60 * 1000).unref();

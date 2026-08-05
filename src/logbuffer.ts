// Buffer de logs en mémoire pour l'admin (page Logs). On intercepte console.*,
// on range { seq, ts, level, source, msg } dans un ring borné, PUIS on délègue à
// l'original (les logs Docker restent intacts). Les secrets sont masqués avant
// stockage — ce buffer est lisible via /api/logs (derrière la session admin),
// il ne doit jamais contenir OWNER_KEY/ACCESS_KEY en clair.

export interface LogLine {
  seq: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  msg: string;
}

const MAX = 1000;
const ring: LogLine[] = [];
let seq = 0;

/** Masque les secrets connus dans une ligne de log. */
export function maskSecrets(s: string): string {
  let out = s;
  for (const v of [process.env.OWNER_KEY, process.env.ACCESS_KEY, process.env.MEDIAFLOW_PASSWORD]) {
    if (v && v.length >= 4) out = out.split(v).join('***');
  }
  // Valeurs de query sensibles, même si la clé n'est pas dans l'env (défense).
  out = out.replace(/([?&](?:k|api_password|password)=)[^&\s]+/gi, '$1***');
  return out;
}

// Niveau déduit du texte pour les lignes venant de console.log (qui sert de
// fourre-tout). Les marqueurs d'erreur/alerte des scrapers priment.
function deriveLevel(fallback: 'info' | 'warn' | 'error', text: string): 'info' | 'warn' | 'error' {
  if (fallback === 'error') return 'error';
  if (/\b(error|échec|failed|KO)\b|❌/i.test(text)) return 'error';
  if (/⚠|\bwarn(ing)?\b|not whitelisted/i.test(text)) return 'warn';
  return fallback;
}

// Source = tag [Xxx] en tête de ligne, sinon 'system'.
function deriveSource(text: string): string {
  const m = text.match(/^\s*\[([A-Za-z0-9 _-]{1,24})\]/);
  return m ? m[1].trim() : 'system';
}

export function pushLog(level: 'info' | 'warn' | 'error', text: string): void {
  const masked = maskSecrets(text);
  ring.push({
    seq: ++seq,
    ts: Date.now(),
    level: deriveLevel(level, masked),
    source: deriveSource(masked),
    msg: masked.length > 2000 ? masked.slice(0, 2000) + '…' : masked,
  });
  if (ring.length > MAX) ring.shift();
}

export function getLogs(opts: {
  sinceSeq?: number; source?: string; level?: string; q?: string; limit?: number;
} = {}): { lines: LogLine[]; lastSeq: number; sources: string[] } {
  const sources = [...new Set(ring.map(l => l.source))].sort();
  const q = opts.q ? opts.q.toLowerCase() : '';
  let lines = ring.filter(l =>
    (opts.sinceSeq == null || l.seq > opts.sinceSeq) &&
    (!opts.source || l.source === opts.source) &&
    (!opts.level || l.level === opts.level) &&
    (!q || l.msg.toLowerCase().includes(q)),
  );
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), MAX);
  if (lines.length > limit) lines = lines.slice(lines.length - limit);
  return { lines, lastSeq: seq, sources };
}

let installed = false;
export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const wrap = (level: 'info' | 'warn' | 'error', fn: (...a: any[]) => void) =>
    (...args: any[]) => {
      try {
        pushLog(level, args.map(a => (typeof a === 'string' ? a : safeStr(a))).join(' '));
      } catch { /* ne jamais casser un console.* */ }
      fn(...args);
    };
  console.log = wrap('info', orig.log);
  console.warn = wrap('warn', orig.warn);
  console.error = wrap('error', orig.error);
}

function safeStr(a: unknown): string {
  try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
  catch { return String(a); }
}

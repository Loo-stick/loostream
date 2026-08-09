import { AsyncLocalStorage } from 'async_hooks';

// Capture des logs par requête. Un contexte (pseudo + buffer) est posé au début de
// handleStream via runWithLogCapture ; installLogCapture() wrap console.log UNE fois pour
// pousser chaque ligne dans le buffer du contexte courant EN PLUS de stdout. Hors requête
// (pas de contexte) -> aucun effet. Sert à stocker la trace d'une requête dans user_activity.
type Ctx = { pseudo: string; lines: string[] };
const als = new AsyncLocalStorage<Ctx>();
const MAX_LINES = 200;
let installed = false;

function hhmmss(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  const orig = console.log.bind(console);
  console.log = (...args: any[]) => {
    orig(...args);
    const ctx = als.getStore();
    if (ctx && ctx.lines.length < MAX_LINES) {
      ctx.lines.push(`${hhmmss()} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`);
    }
  };
}

export function runWithLogCapture<T>(pseudo: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ pseudo, lines: [] }, fn);
}

export function capturedLines(): string {
  const c = als.getStore();
  return c ? c.lines.join('\n') : '';
}

export function currentPseudo(): string | undefined {
  return als.getStore()?.pseudo;
}

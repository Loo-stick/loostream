import { AsyncLocalStorage } from 'async_hooks';

// Capture des logs par requête. Un contexte (pseudo + buffer) est posé au début de
// handleStream via runWithLogCapture. C'est logbuffer.pushLog (le wrap unique de console.*)
// qui appelle captureLine() avec le texte DÉJÀ MASQUÉ -> le buffer par requête n'expose
// jamais de secret. Hors requête (pas de contexte) -> captureLine ne fait rien.
// Sert à stocker la trace d'une requête dans user_activity (logs détaillés par utilisateur).
type Ctx = { pseudo: string; lines: string[] };
const als = new AsyncLocalStorage<Ctx>();
const MAX_LINES = 200;

function hhmmss(): string {
  return new Date().toTimeString().slice(0, 8);
}

// Appelé par logbuffer pour CHAQUE ligne de log (déjà masquée). Pousse dans le buffer du
// contexte de requête courant s'il existe, borné à MAX_LINES.
export function captureLine(masked: string): void {
  const ctx = als.getStore();
  if (ctx && ctx.lines.length < MAX_LINES) ctx.lines.push(`${hhmmss()} ${masked}`);
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

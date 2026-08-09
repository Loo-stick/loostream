// Pseudo optionnel auto-déclaré par l'utilisateur (dans configure), embarqué dans la
// config base64. Nettoyé avant tout usage (log/BDD) : lettres/chiffres/espace/_.- ,
// longueur bornée. Vide -> traité comme absent via pseudoLabel().
const ALLOWED = /[^\p{L}\p{N} _.\-]/gu;

export function sanitizePseudo(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(ALLOWED, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

export function pseudoLabel(raw: unknown): string {
  const p = sanitizePseudo(raw);
  return p.length ? p : '(anonyme)';
}

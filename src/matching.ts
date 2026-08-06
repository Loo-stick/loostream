// Matcher de titre PARTAGÉ, précision d'abord (voir
// docs/superpowers/specs/2026-08-05-title-matching-design.md).
// Pur, sans I/O : chaque scraper par titre construit des Candidate et délègue la
// sélection. Remplace les matchings par SOUS-CHAÎNE (qui faisaient matcher
// « My Happy Ending » sur « Happy End ») par une égalité de token-set + année.

export interface Wanted { titles: string[]; year?: number }
export interface Candidate<T> { title: string; year?: number; item: T }
export type YearVerdict = 'exact' | 'close' | 'unknown' | 'mismatch';

// Articles/liaisons + tags de version + marqueurs saison : bruit à ignorer pour comparer.
const STOPWORDS = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'de', 'des', 'du', 'the', 'a', 'an', 'of', 'and', 'et',
  'vf', 'vostfr', 'vost', 'vo', 'multi', 'french', 'truefrench',
  'saison', 'season', 'episode', 'ep',
]);

export function normalizeTokens(s: string): string[] {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // diacritiques
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t) && !/^(19|20)\d\d$/.test(t)); // retire les tokens ANNÉE
}

function tokenSet(s: string): Set<string> { return new Set(normalizeTokens(s)); }
function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** ÉGALITÉ de token-set avec au moins un titre voulu (FR/original). Pas de sous-chaîne. */
export function titlesMatch(wantedTitles: string[], candidateTitle: string): boolean {
  const c = tokenSet(candidateTitle);
  if (c.size === 0) return false;
  return wantedTitles.some(w => { const ws = tokenSet(w); return ws.size > 0 && setEq(ws, c); });
}

// Étend une liste de titres avec leur NOM DE BASE (avant un sous-titre « : » / « - »).
// TMDB nomme souvent « X: Jobless Reincarnation » là où un site FR/anime n'a que
// « X » -> sans ça le matcher strict rejette. On ajoute juste des variantes exactes
// candidates (la précision reste : on compare toujours en token-set exact).
//
// Séparateurs de sous-titre (chacun DOIT être borné par un espace du bon côté,
// sinon on couperait un titre où la ponctuation fait partie du nom) :
//   • « : » suivi d'un espace   -> « Mushoku Tensei: Jobless » = « Mushoku Tensei »
//     (mais PAS « Re:Zero » : le « : » collé fait partie du nom).
//   • un espace puis un tiret   -> « Re:ZERO -Starting Life… » = « Re:ZERO »
//     (mais PAS « Spider-Man » : tiret collé).
export function expandTitles(titles: string[]): string[] {
  const out = new Set<string>();
  for (const t of titles) {
    if (!t) continue;
    out.add(t);
    const base = t.split(/\s*[:–—]\s+|\s+[-–—]\s*/)[0].trim();
    if (base && base.length >= 3) out.add(base);
  }
  return [...out];
}

export function yearVerdict(wanted: number | undefined, candidate: number | undefined): YearVerdict {
  if (!wanted || !candidate) return 'unknown';
  const d = Math.abs(wanted - candidate);
  return d === 0 ? 'exact' : d <= 1 ? 'close' : 'mismatch';
}

/** Précision d'abord : titre token-set exact ET année non contradictoire. */
export function accepts<T>(wanted: Wanted, c: Candidate<T>): boolean {
  return titlesMatch(wanted.titles, c.title) && yearVerdict(wanted.year, c.year) !== 'mismatch';
}

const YEAR_RANK: Record<YearVerdict, number> = { exact: 0, close: 1, unknown: 2, mismatch: 3 };
export function pickBest<T>(wanted: Wanted, candidates: Candidate<T>[]): Candidate<T> | null {
  const accepted = candidates.filter(c => accepts(wanted, c));
  if (accepted.length === 0) return null;
  const norm = (s: string) => normalizeTokens(s).join(' ');
  const wantedNorms = wanted.titles.map(norm);
  accepted.sort((a, b) => {
    const yr = YEAR_RANK[yearVerdict(wanted.year, a.year)] - YEAR_RANK[yearVerdict(wanted.year, b.year)];
    if (yr !== 0) return yr;
    // à année égale, l'égalité de chaîne normalisée (ordre inclus) départage
    return (wantedNorms.includes(norm(a.title)) ? 0 : 1) - (wantedNorms.includes(norm(b.title)) ? 0 : 1);
  });
  return accepted[0];
}

// Préférences utilisateur : normalisation langue/qualité + prédicat de filtrage.
// Extrait d'index.ts pour être testable (index.ts démarre le serveur à l'import).
//
// RÈGLE (depuis v1.12.1) : le filtrage ne porte QUE sur la LANGUE. La qualité ne
// filtre plus — elle ne sert qu'au TRI (voir filterAndSortStreams).
//
// Historique du bug : le seuil qualité `score >= prefScore-1` existait mais restait
// INERTE tant que les extracteurs sortaient le label générique 'HD' (normalisé en
// 1080p → passe toujours). En v1.12.0 on a lu la vraie résolution (relabel) → le
// seuil s'est mis à jeter tout flux réellement < 720p (un vidzy VF 480p, par ex.),
// amputant des sources parfaitement valides (« que MovieBox », « plus de VF »).
// On garde donc la qualité au tri, jamais au couperet.

export const QUALITY_SCORES: Record<string, number> = {
  '4K': 4,
  '1080p': 3,
  '720p': 2,
  '576p': 1.5,
  '480p': 1,
  '360p': 0.6,
  'HD': 2, // repli si la résolution n'a pas pu être mesurée (label générique)
};

export function normalizeLanguage(lang: string): string {
  const upper = lang.toUpperCase();
  if (upper.includes('MULTI')) return 'MULTI';
  if (upper.includes('VOSTFR') || upper.includes('VOST')) return 'VOSTFR';
  if (upper.includes('VF') || upper === 'FRENCH' || upper === 'FRANÇAIS') return 'VF';
  if (upper.includes('VO') || upper === 'ORIGINAL' || upper === 'EN' || upper === 'ENGLISH') return 'VO';
  return 'VO'; // Default to VO for unknown
}

export function normalizeQuality(quality: string): string {
  const upper = quality.toUpperCase();
  if (upper.includes('4K') || upper.includes('2160')) return '4K';
  if (upper.includes('1080')) return '1080p';
  if (upper.includes('720')) return '720p';
  if (upper.includes('576')) return '576p';
  if (upper.includes('480') || upper.includes('SD')) return '480p';
  if (upper.includes('360')) return '360p';
  if (upper.includes('HD') || upper.includes('FULL')) return '1080p';
  return '720p'; // Default
}

/**
 * Un flux passe-t-il les préférences ? FILTRE DE LANGUE UNIQUEMENT — la qualité ne
 * filtre pas (un 480p peut être la seule source VF dispo ; elle départage au tri).
 * NetMirror est exempté (HLS multi-langue, comme il l'a toujours été).
 */
export function passesPreferences(
  meta: { quality: string; language: string; source: string },
  langOrder: string[],
): boolean {
  if (meta.source === 'netmirror') return true;
  return langOrder.includes(normalizeLanguage(meta.language));
}

/** Rang d'une langue dans l'ordre de préférence (inconnue = tout en bas). */
function langRank(lang: string, order: string[]): number {
  const i = order.indexOf(normalizeLanguage(lang));
  return i === -1 ? 100 : i;
}

// Comparateur de tri. Deux composantes : LANGUE (rang dans langOrder) et QUALITÉ
// (proximité à la qualité préférée, puis meilleure en départage). `sortBy` choisit
// laquelle prime :
//   - 'language' (défaut) : langue d'abord, qualité en second — « ma langue, puis le
//     mieux dedans ».
//   - 'quality'          : qualité d'abord, langue en second — un 4K remonte quelle
//     que soit sa langue.
export type SortBy = 'language' | 'quality';
export function compareStreams(
  a: { quality: string; language: string },
  b: { quality: string; language: string },
  opts: { langOrder: string[]; prefQualityScore: number; sortBy: SortBy },
): number {
  const langCmp = langRank(a.language, opts.langOrder) - langRank(b.language, opts.langOrder);
  const aQ = QUALITY_SCORES[normalizeQuality(a.quality)] || 2;
  const bQ = QUALITY_SCORES[normalizeQuality(b.quality)] || 2;
  const diffCmp = Math.abs(aQ - opts.prefQualityScore) - Math.abs(bQ - opts.prefQualityScore);
  const highCmp = bQ - aQ; // meilleure qualité d'abord
  return opts.sortBy === 'quality'
    ? (diffCmp || langCmp || highCmp)
    : (langCmp || diffCmp || highCmp);
}

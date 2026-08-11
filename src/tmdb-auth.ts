// Authentification TMDB : gère les DEUX formats de clé que la page TMDB propose, et que
// les utilisateurs confondent souvent :
//   - v3  = « API Key »              -> 32 hex, passée en query `?api_key=…`
//   - v4  = « API Read Access Token » -> un JWT (eyJ….….…), passé en `Authorization: Bearer`
// Envoyer un token v4 en `?api_key=` -> 401 (cause fréquente des « Vide » : pas de TMDB,
// donc pas de flux). On détecte le type et on construit la requête correctement.

export type TmdbKeyType = 'v3' | 'v4' | 'unknown';

export function tmdbKeyType(key: string): TmdbKeyType {
  const k = (key || '').trim();
  if (/^[a-f0-9]{32}$/i.test(k)) return 'v3';
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(k)) return 'v4';
  return 'unknown';
}

/**
 * Construit l'URL + les headers pour un endpoint TMDB v3, en gérant v3 et v4.
 * `path` = tout ce qui suit `/3/` (peut déjà porter une query, ex.
 * "find/tt123?external_source=imdb_id"). Une clé « unknown » est tentée en v3 (TMDB
 * répondra 401, remonté normalement).
 */
export function tmdbReq(path: string, key: string): { url: string; headers?: Record<string, string> } {
  const base = `https://api.themoviedb.org/3/${path}`;
  if (tmdbKeyType(key) === 'v4') {
    return { url: base, headers: { Authorization: `Bearer ${(key || '').trim()}` } };
  }
  const sep = path.includes('?') ? '&' : '?';
  return { url: `${base}${sep}api_key=${encodeURIComponent((key || '').trim())}` };
}

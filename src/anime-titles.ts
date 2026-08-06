import axios from 'axios';
import { cached } from './cache';
import { normalizeTokens } from './matching';

// Titre ROMAJI d'un anime via AniList (GraphQL, keyless). Les sites FR d'anime
// (voir-anime, anime-sama) indexent souvent en romaji — « Re:Zero kara Hajimeru
// Isekai Seikatsu » — que ni le titre TMDB anglais ni le kanji ne donnent. On le
// récupère ici et on l'ajoute aux titres candidats du matcher (égalité de token-set
// stricte préservée : le romaji colle EXACTEMENT au titre du site).
//
// AniList search est fuzzy -> on BLINDE : on n'accepte le résultat que si son `native`
// (kanji) == notre `originalTitle` TMDB, ou son `english` == notre `title`. Zéro faux
// match. Gaté anime (originalLanguage=ja) côté appelant -> faible volume, caché 24 h.

const ANILIST = 'https://graphql.anilist.co';
const TTL_MS = 24 * 60 * 60 * 1000;
const QUERY = 'query($s:String){Media(search:$s,type:ANIME){title{romaji english native}}}';

/** Clé de comparaison kanji : NFKC, sans espaces ni ponctuation de liaison. */
function kanjiKey(s: string): string {
  return (s || '').normalize('NFKC').replace(/[\s　]+/g, '').replace(/[:：・\-–—]/g, '');
}
const tokenKey = (s: string): string => normalizeTokens(s).join(' ');

/** Renvoie [romaji] vérifié, ou [] si pas d'anime fiable trouvé. */
export async function getAnimeAltTitles(title: string, originalTitle?: string): Promise<string[]> {
  if (!title) return [];
  return cached<string[]>(
    `anilist:alt:${title.toLowerCase()}`,
    TTL_MS,
    async () => {
      try {
        const { data } = await axios.post(
          ANILIST,
          { query: QUERY, variables: { s: title } },
          { timeout: 10000, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
        );
        const m = data?.data?.Media;
        if (!m) return [];
        const romaji = String(m.title?.romaji || '');
        const english = String(m.title?.english || '');
        const native = String(m.title?.native || '');
        if (!romaji) return [];
        // Vérification anti-fuzzy : kanji identique, ou titre anglais identique.
        const kanjiOk = !!originalTitle && !!native && kanjiKey(native) === kanjiKey(originalTitle);
        const engOk = !!english && tokenKey(english) === tokenKey(title);
        if (!kanjiOk && !engOk) return [];
        return [romaji];
      } catch {
        return [];
      }
    },
    { scope: 'anilist', shouldCache: r => r.length > 0 },
  );
}

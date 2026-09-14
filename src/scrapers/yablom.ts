// Yablom (yablom.com, alias « Yablom — ShareCloudy ») — films FR généralistes,
// catalogue propre indexé par titre avec jaquettes TMDB. Repéré dans Onyx v1.7.250.
// FILMS UNIQUEMENT (pas de séries : la recherche ne renvoie qu'une clé `films`).
//
// Chaîne (reverse depuis Onyx) :
//   1. recherche JSON : /euvcw7/api_search.php?searchword=<titre>&offset=0&limit=20
//      &folder=euvcw7&pr=yablom  -> {films:[{title:"Titre (AAAA)", link, hd, vostfr, cat}]}
//   2. le `link` vaut « /ALBRAD/b/localhost/<id> » : ALBRAD/localhost sont des
//      placeholders -> la vraie page est /euvcw7/b/yablom/<id>.
//   3. cette page embarque UNE iframe ShareCloudy (`sharecloudy.com/iframe/<code>`),
//      hôte que nos extracteurs gèrent déjà -> m3u8 HD.
//
// GOTCHA en-têtes : la page /b/ boucle en 302 sans `Cookie: g=true`, un UA Firefox
// et `X-Requested-With: XMLHttpRequest` (vérifié : 302 en boucle sinon, 200 avec).

import axios from 'axios';
import { extractStream, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';
import { titlesMatch, expandTitles } from '../matching';

const endpoints = makeEndpointConfig('yablom-endpoints.json', 'YABLOM_ENDPOINTS_CONFIG', {
  base: 'https://yablom.com',
});
export const getYablomEndpoints = endpoints.get;
export const reloadYablomEndpoints = endpoints.reload;

const BASE = () => String(endpoints.get().base).replace(/\/+$/, '');
const FOLDER = 'euvcw7'; // segment de chemin de leur build courant

// La page /b/ EXIGE ce jeu d'en-têtes (UA Firefox, cookie g=true, en-tête ajax),
// sinon elle boucle en 302. Relevé dans le YablomProvider d'Onyx.
const FF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0';
function pageHeaders(): Record<string, string> {
  return {
    'User-Agent': FF_UA,
    Accept: '*/*',
    'Accept-Language': 'fr-FR,fr;q=0.9',
    Cookie: 'g=true',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${BASE()}/${FOLDER}/home/yablom`,
  };
}

const SEARCH_TTL_MS = 3 * 60 * 60 * 1000;
const EMBED_TTL_MS = 6 * 60 * 60 * 1000;

interface RawFilm { title: string; link: string; hd?: boolean; vostfr?: boolean; cat?: string }
interface Candidate { id: string; title: string; year: number; vostfr: boolean }

// « Titre (2023) » -> {titre nu, année}. Onyx lit l'année via /\((\d{4})\)/.
function splitTitleYear(t: string): { title: string; year: number } {
  const clean = (t || '').replace(/‎/g, '').trim();
  const m = clean.match(/\((\d{4})\)\s*$/);
  return { title: m ? clean.slice(0, m.index).trim() : clean, year: m ? Number(m[1]) : 0 };
}

/** L'id de flux vit dans le `link` (« …/b/localhost/<id> »), PAS dans le champ `id`. */
function idFromLink(link: string): string {
  const m = (link || '').match(/\/(\d+)\s*$/);
  return m ? m[1] : '';
}

function stripAccents(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Requête de recherche. Leur moteur CASSE au tiret et à l'apostrophe (« Monte-Cristo »
// est stocké « montecristo » ; une requête « monte cristo » OU « montecristo » rend 0,
// mais « le comte de monte », tronquée AVANT le tiret, rend la fiche). On tronque donc
// au 1er tiret/apostrophe, puis on normalise. La précision reste assurée par le
// rapprochement strict sur les titres RENVOYÉS. Garde-fou : si la troncature devient
// trop courte (« Spider-Man » -> « spider » ça va, mais « X-Men » -> « x » non), on
// retombe sur le titre entier normalisé.
function searchQuery(title: string): string {
  const norm = (s: string) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const truncated = norm(title.split(/['’‘\-]/)[0]);
  return truncated.length >= 4 ? truncated : norm(title);
}

async function search(query: string): Promise<Candidate[]> {
  const q = searchQuery(query);
  if (!q) return [];
  return cached<Candidate[]>(
    `yablom:search:${q}`, SEARCH_TTL_MS,
    async () => {
      const url = `${BASE()}/${FOLDER}/api_search.php?searchword=${encodeURIComponent(q)}&offset=0&limit=20&folder=${FOLDER}&pr=yablom`;
      try {
        const { data } = await axios.get(url, { headers: pageHeaders(), timeout: 12000, validateStatus: s => s < 500 });
        const films: RawFilm[] = Array.isArray(data?.films) ? data.films : [];
        return films.map(f => {
          const { title, year } = splitTitleYear(f.title);
          return { id: idFromLink(f.link), title, year, vostfr: !!f.vostfr };
        }).filter(c => c.id && c.title);
      } catch {
        return [];
      }
    },
    { scope: 'yablom', shouldCache: r => r.length > 0, negativeTtlMs: 30 * 60 * 1000 },
  );
}

/** URL de l'iframe ShareCloudy de la page d'un film, ou '' si absente. */
async function sharecloudyEmbed(id: string): Promise<string> {
  return cached<string>(
    `yablom:embed:${id}`, EMBED_TTL_MS,
    async () => {
      try {
        const { data } = await axios.get<string>(`${BASE()}/${FOLDER}/b/yablom/${id}`, {
          headers: pageHeaders(), timeout: 12000, responseType: 'text', transformResponse: v => v,
          validateStatus: s => s < 400, maxRedirects: 3, maxContentLength: 4 * 1024 * 1024,
        });
        if (typeof data !== 'string') return '';
        const m = data.match(/<iframe[^>]*src="([^"]*sharecloudy[^"]*)"/i);
        return m ? m[1].replace(/&amp;/g, '&') : '';
      } catch {
        return '';
      }
    },
    { scope: 'yablom', shouldCache: u => u !== '', negativeTtlMs: 30 * 60 * 1000 },
  );
}

export interface YablomStream {
  url: string;
  quality: string;
  language: string;
  server: string;
  headers?: Record<string, string>;
}

export async function getYablomStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle?: string,
  year?: number,
): Promise<YablomStream[]> {
  if (mediaType !== 'movie' || !title) return []; // catalogue 100 % films

  const wanted = expandTitles([title, originalTitle].filter(Boolean) as string[]);
  // Une recherche par titre distinct (souvent 1 : le FR suffit).
  const queries = [...new Set([title, originalTitle].filter(Boolean) as string[])].slice(0, 2);
  const found = new Map<string, Candidate>();
  for (const list of await Promise.all(queries.map(q => search(q).catch(() => [] as Candidate[])))) {
    for (const c of list) found.set(c.id, c);
  }
  // Correspondance stricte : titre token-set + année ±1 (homonymes/remakes).
  const hit = [...found.values()].find(c =>
    titlesMatch(wanted, c.title) && (!year || !c.year || Math.abs(c.year - year) <= 1));
  if (!hit) return [];

  const embed = await sharecloudyEmbed(hit.id);
  if (!embed) return [];

  const r = await extractStream(embed, extractorConfig).catch(() => null);
  if (!r?.url) return [];

  const language = hit.vostfr ? 'VOSTFR' : 'VF'; // site FR : doublage par défaut
  console.log(`[Yablom] "${title}" -> ${r.format} ${r.quality || 'HD'} (${language})`);
  return [{ url: r.url, quality: r.quality || 'HD', language, server: 'sharecloudy', headers: r.headers }];
}

/** Santé : la recherche répond et rend au moins un film pour un titre courant. */
export async function yablomProbe(): Promise<boolean> {
  return (await search('avatar')).length > 0;
}

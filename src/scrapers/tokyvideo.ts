// Tokyvideo (www.tokyvideo.com) — vieux films et séries en VF (Columbo, X-Files, Code
// Quantum, Magnum, Albator…). Flux MP4 DIRECT, gratuit, sans anti-bot. Comble le
// catalogue ancien que nos autres sources couvrent mal.
//
// Repéré dans Onyx v1.7.250 (source de secours). On NE scrape PAS la recherche du site :
// Onyx s'appuie sur un index JSON public tenu à jour (github xdata-mix/nx-data), qui liste
// tout le catalogue avec les slugs. On fait pareil : l'index sert d'index de recherche
// (keyé titre, sans identifiant TMDB), et la page de chaque titre porte le MP4.
//
// LIVRAISON : le MP4 exige le Referer du site (403 avec un Referer étranger, OK sans ou
// avec le sien) et porte un jeton `secure=<hash>,<expiration>` valable ~24 h. Assez long
// pour résoudre dès la recherche (et mesurer la vraie résolution). Jeton NON lié au réseau
// -> livrable en direct (proxyHeaders Referer) comme en proxy.

import axios from 'axios';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';
import { probeMp4Quality } from '../mp4probe';
import { normalizeTokens, titlesMatch, expandTitles } from '../matching';

const endpoints = makeEndpointConfig('tokyvideo-endpoints.json', 'TOKYVIDEO_ENDPOINTS_CONFIG', {
  base: 'https://www.tokyvideo.com',
  index: 'https://raw.githubusercontent.com/xdata-mix/nx-data/main/data/tokyvideo/index.json',
});

export const getTokyvideoEndpoints = endpoints.get;
export const reloadTokyvideoEndpoints = endpoints.reload;

const BASE = () => String(endpoints.get().base).replace(/\/+$/, '');
const INDEX_URL = () => String(endpoints.get().index);

export const TOKYVIDEO_REFERER = 'https://www.tokyvideo.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const PAGE_TTL_MS = 12 * 60 * 60 * 1000; // le jeton du MP4 vit ~24 h -> on peut cacher la page

// ── Index (recherche) ─────────────────────────────────────────────────────────

interface RawFilm { vid: string; slug: string; t: string; y: number; k: string }
// Épisode : [numéro, vid, slug, titre]
type RawEp = [number, string, string, string];
interface RawSeries { id: string; slug: string; t: string; y: number; k: string; n: number; s: Record<string, RawEp[]> }

interface Film { slug: string; title: string; year: number; wanted: string[] }
interface Series { title: string; year: number; wanted: string[]; seasons: Record<string, RawEp[]> }
interface Index { films: Film[]; series: Series[] }

// Les titres du site sont pollués de mots-clés SEO (« 'X' Film Gratuit », « … streaming »).
// On les retire avant tout rapprochement, sinon le matcher strict ne trouve jamais.
const SEO = /\b(films?|gratuits?|streaming|complets?|version\s+fran[cç]aise|en\s+fran[cç]ais|vf2?|vff|vfq|vostfr|vost|\bvo\b|hd|uhd|4k|720p?|1080p?)\b/gi;
function cleanTitle(t: string): string {
  return t.replace(/^['"\s]+|['"\s]+$/g, '').replace(SEO, ' ').replace(/\s+/g, ' ').trim().replace(/[\s:'"\-]+$/g, '').trim();
}

let indexCache: { value: Index | null; at: number } | null = null;
let indexLoading: Promise<Index | null> | null = null;

async function loadIndex(): Promise<Index | null> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.value;
  if (indexLoading) return indexLoading;
  indexLoading = (async () => {
    try {
      const { data } = await axios.get(INDEX_URL(), {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        timeout: 20000, maxContentLength: 16 * 1024 * 1024,
      });
      const films: Film[] = (Array.isArray(data?.films) ? data.films : [])
        .filter((f: RawFilm) => f?.slug && f?.t)
        .map((f: RawFilm) => { const c = cleanTitle(f.t); return { slug: f.slug, title: c, year: Number(f.y) || 0, wanted: expandTitles([c]) }; });
      const series: Series[] = (Array.isArray(data?.series) ? data.series : [])
        .filter((s: RawSeries) => s?.t && s?.s)
        .map((s: RawSeries) => { const c = cleanTitle(s.t); return { title: c, year: Number(s.y) || 0, wanted: expandTitles([c]), seasons: s.s }; });
      const idx: Index = { films, series };
      indexCache = { value: idx, at: Date.now() };
      console.log(`[Tokyvideo] index chargé : ${films.length} films, ${series.length} séries`);
      return idx;
    } catch (e: any) {
      console.log(`[Tokyvideo] index injoignable : ${e?.message || e}`);
      // Repli : garder un index périmé plutôt que rien.
      return indexCache?.value ?? null;
    } finally {
      indexLoading = null;
    }
  })();
  return indexLoading;
}

// ── Résolution du MP4 ─────────────────────────────────────────────────────────

/** URL MP4 (avec son jeton) lue dans la page d'un slug, ou '' si absente. */
async function resolveMp4(slug: string): Promise<string> {
  return cached<string>(
    `tokyvideo:mp4:${slug}`, PAGE_TTL_MS,
    async () => {
      try {
        const { data } = await axios.get<string>(`${BASE()}/fr/video/${slug}`, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9', Referer: `${BASE()}/` },
          timeout: 12000, responseType: 'text', transformResponse: v => v,
          validateStatus: s => s < 500, maxContentLength: 4 * 1024 * 1024,
        });
        if (typeof data !== 'string') return '';
        // <source src="https://cdnst*.tokyvideo.com/.../<hash>.mp4?secure=...">
        const m = data.match(/<source[^>]+src="([^"]+\.mp4[^"]*)"/i);
        return m ? m[1].replace(/&amp;/g, '&') : '';
      } catch {
        return '';
      }
    },
    { scope: 'tokyvideo', shouldCache: u => u !== '', negativeTtlMs: 30 * 60 * 1000 },
  );
}

function languageOf(title: string): string {
  return /\bvostfr\b/i.test(title) ? 'VOSTFR' : 'VF'; // site FR : doublage par défaut
}

export interface TokyvideoStream {
  url: string;
  quality: string;
  language: string;
  server: string;
}

// ── Point d'entrée ─────────────────────────────────────────────────────────────

export async function getTokyvideoStreams(
  mediaType: 'movie' | 'series',
  titles: string[],
  year?: number,
  season?: number,
  episode?: number,
): Promise<TokyvideoStream[]> {
  const wanted = titles.filter(Boolean);
  if (wanted.length === 0) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];

  const idx = await loadIndex();
  if (!idx) return [];

  let slug = '';
  if (mediaType === 'movie') {
    // Titre exact (token-set) + année à ±1 (beaucoup d'homonymes dans le vieux catalogue).
    const hit = idx.films.find(f =>
      f.wanted.some(w => titlesMatch(wanted, w)) &&
      (!year || !f.year || Math.abs(f.year - year) <= 1));
    slug = hit?.slug || '';
  } else {
    // Année souvent absente (0) sur les séries -> on ne l'exige pas ; épisode exact requis.
    const hit = idx.series.find(s => s.wanted.some(w => titlesMatch(wanted, w)));
    if (hit) {
      const eps = hit.seasons[String(season)] || (Object.keys(hit.seasons).length === 1 ? Object.values(hit.seasons)[0] : undefined);
      slug = eps?.find(e => e[0] === episode)?.[2] || '';
    }
  }
  if (!slug) return [];

  const url = await resolveMp4(slug);
  if (!url) return [];

  // Vraie résolution lue dans le MP4 (Referer requis) ; sinon libellé générique.
  const quality = (await probeMp4Quality(url, { Referer: TOKYVIDEO_REFERER }).catch(() => null)) || 'SD';
  console.log(`[Tokyvideo] "${wanted[0]}"${mediaType === 'series' ? ` S${season}E${episode}` : ''} -> ${quality}`);
  return [{ url, quality, language: languageOf(slug), server: 'tokyvideo' }];
}

/** Santé : l'index public répond et liste des titres. */
export async function tokyvideoProbe(): Promise<boolean> {
  const idx = await loadIndex();
  return !!idx && (idx.films.length > 0 || idx.series.length > 0);
}

import axios from 'axios';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';
import { ExtractorConfig, detectExtractor, extractStream } from '../extractors';
import { applyMultiAudio } from '../multiaudio';
import { Wanted, pickBest } from '../matching';

// AnimeSama (anime-sama.to) — source ANIME (VOSTFR + VF). HTML scraping :
//   1. Recherche : POST /template-php/defaut/fetch.php?query= -> fiches /catalogue/{slug}/
//      (fuzzy -> on tranche avec le matcher de titre strict).
//   2. Épisodes : GET /catalogue/{slug}/{saisonN|film}/{vostfr|vf}/episodes.js
//      -> `var eps1 = ['url', …]` : UN tableau par LECTEUR, index = épisode-1.
//   3. Extraction via nos extracteurs (sibnet, ansembed…), 1 miroir suffit par langue.
// Gaté sur l'anime (originalLanguage=ja) côté index.ts, comme VoirAnime.

const STREAMS_TTL_MS = 15 * 60 * 1000;
const MAX_EXTRACT = 4; // essaie au plus 4 miroirs par langue avant d'abandonner

const endpoints = makeEndpointConfig('animesama-endpoints.json', 'ANIMESAMA_ENDPOINTS_CONFIG', {
  base: 'https://anime-sama.to',
});
export const reloadAnimesamaEndpoints = endpoints.reload;
export const getAnimesamaEndpoints = endpoints.get;
const BASE = () => endpoints.get().base.replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface AnimeSamaStream {
  name: string;
  url: string;
  quality: string;
  language: string;
  headers?: Record<string, string>;
}

/** Renvoie UNE URL par tableau-lecteur (var epsN) pour l'épisode `idx` (0-based). */
export function parseEpisodesJs(js: string, idx: number): string[] {
  const out: string[] = [];
  for (const m of js.matchAll(/var\s+eps\w+\s*=\s*\[([\s\S]*?)\]/g)) {
    const urls = [...m[1].matchAll(/['"]((?:https?:)?\/\/[^'"]+)['"]/g)].map(u => u[1]);
    const u = urls[idx];
    if (u) out.push(u.startsWith('//') ? 'https:' + u : u);
  }
  return out;
}

async function getText(url: string, referer: string): Promise<string | null> {
  try {
    const { data, status } = await axios.get<string>(url, {
      headers: { 'User-Agent': UA, Referer: referer },
      timeout: 12000, responseType: 'text', transformResponse: r => r, validateStatus: () => true,
    });
    return status >= 200 && status < 300 ? String(data) : null;
  } catch { return null; }
}

// Recherche -> slug retenu via le matcher (titres FR + original + EN ; pas d'année).
async function findSlug(titles: string[]): Promise<string | null> {
  const base = BASE();
  const wanted: Wanted = { titles };
  for (const t of titles) {
    try {
      const { data } = await axios.post<string>(
        `${base}/template-php/defaut/fetch.php`,
        `query=${encodeURIComponent(t)}`,
        {
          headers: { 'User-Agent': UA, Referer: `${base}/`, 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 12000, responseType: 'text', transformResponse: r => r,
        },
      );
      const items: { title: string; item: string }[] = [];
      for (const m of String(data).matchAll(/href="[^"]*\/catalogue\/([a-z0-9-]+)\/"[\s\S]*?asn-search-result-title">([^<]+)</gi)) {
        items.push({ item: m[1], title: m[2].trim() });
      }
      const best = pickBest(wanted, items);
      if (best) return best.item;
    } catch { /* titre suivant */ }
  }
  return null;
}

async function fetchAnimeSamaStreams(
  mediaType: 'movie' | 'series', titles: string[], season: number | undefined,
  episode: number | undefined, extractorConfig: ExtractorConfig,
): Promise<AnimeSamaStream[]> {
  const base = BASE();
  const slug = await findSlug(titles);
  if (!slug) { console.log(`[AnimeSama] Aucun match pour "${titles[0]}"`); return []; }

  const seasonPath = mediaType === 'movie' ? 'film' : `saison${season}`;
  const idx = mediaType === 'movie' ? 0 : (episode! - 1);
  const streams: AnimeSamaStream[] = [];

  for (const lang of ['vostfr', 'vf']) {
    const js = await getText(`${base}/catalogue/${slug}/${seasonPath}/${lang}/episodes.js`, `${base}/catalogue/${slug}/`);
    if (!js) continue;
    // Lecteurs qu'on sait extraire, dédoublonnés par hôte.
    const seenHost = new Set<string>();
    const candidates = parseEpisodesJs(js, idx).filter(u => {
      if (!detectExtractor(u)) return false;
      let h = ''; try { h = new URL(u).hostname; } catch { return false; }
      if (seenHost.has(h)) return false; seenHost.add(h); return true;
    }).slice(0, MAX_EXTRACT);

    for (const u of candidates) {
      const ex = await extractStream(u, extractorConfig).catch(() => null);
      if (ex?.url) {
        streams.push({ name: 'AnimeSama', url: ex.url, quality: ex.quality || 'HD', language: lang === 'vf' ? 'VF' : 'VOSTFR', headers: ex.headers });
        break; // une source suffit par langue
      }
    }
  }
  console.log(`[AnimeSama] "${titles[0]}" ${seasonPath} -> ${streams.length} stream(s)`);
  return streams;
}

export async function getAnimeSamaStreams(
  mediaType: 'movie' | 'series', titles: string[], season: number | undefined,
  episode: number | undefined, extractorConfig: ExtractorConfig,
): Promise<AnimeSamaStream[]> {
  const uniq = [...new Set(titles.filter(Boolean))];
  if (!uniq.length) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = `animesama:${mode}:${mediaType}:${uniq[0].toLowerCase()}:${season || ''}:${episode || ''}`;
  return cached(
    key, STREAMS_TTL_MS,
    async () => { const s = await fetchAnimeSamaStreams(mediaType, uniq, season, episode, extractorConfig); return applyMultiAudio(s); },
    { scope: 'animesama', shouldCache: r => r.length > 0 },
  );
}

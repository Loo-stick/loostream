import axios from 'axios';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { makeEndpointConfig } from '../endpoint-config';
import { makeDnsSafeAgent } from '../dns-resolve';

// Animoflix (animoflix.to) — anime FR VF ET VOSTFR. Pages season-aware, langue EXPLICITE
// dans l'URL. Protocole reversé le 2026-11-04, SANS captcha :
//
//   Match    : slugify(titre) -> /anime/<slug>/ existe (romaji/anglais). Pas de sitemap ni
//     d'API de recherche -> slugify-and-try sur le titre + alts romaji (AniList).
//   Épisode  : GET /anime/<slug>/saison-<N>/<vf|vostfr>/episode-<E>/ (on tente les 2 langues).
//   Serveurs : <option value="<embed>" data-host="<hôte>"> EN CLAIR dans la page (pas d'AJAX)
//     -> filemoon / ansembed / minochinos(filelions) / sendvid / … -> extractStream.
//
// LANGUE : lue dans le chemin (vf -> VF, vostfr -> VOSTFR). Les hôtes DNS-bloqués par Orange
// (minochinos…) sont gérés par l'agent DNS-safe des extracteurs (dns-resolve.ts).

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const MAX_PER_LANG = 6;   // au plus 6 serveurs sondés par langue

const siteEndpoints = makeEndpointConfig('animoflix-endpoints.json', 'ANIMOFLIX_ENDPOINTS_CONFIG', {
  base: 'https://animoflix.to',
});
export const reloadAnimoflixEndpoints = siteEndpoints.reload;
export const getAnimoflixEndpoints = siteEndpoints.get;
const BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const agent = makeDnsSafeAgent();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LANGS: Array<{ path: 'vostfr' | 'vf'; label: string }> = [
  { path: 'vostfr', label: 'VOSTFR' },
  { path: 'vf', label: 'VF' },
];

export interface AnimoflixStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR
  server: string;
  headers?: Record<string, string>;
}

function slugify(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function hostOf(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/sibnet/.test(h)) return 'sibnet';
    return h.split('.')[0] || 'animoflix';
  } catch { return 'animoflix'; }
}

interface Embed { embed: string; }

async function fetchEpisode(slug: string, season: number, lang: string, episode: number): Promise<Embed[]> {
  try {
    const { data, status } = await axios.get<string>(
      `${BASE()}/anime/${slug}/saison-${season}/${lang}/episode-${episode}/`,
      {
        headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9', Referer: `${BASE()}/anime/${slug}/` },
        timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
        validateStatus: () => true, httpsAgent: agent,
      },
    );
    if (status < 200 || status >= 300 || typeof data !== 'string') return [];
    const out: Embed[] = [];
    const seen = new Set<string>();
    // <option value="<embed>" ... data-host="<hôte>">
    for (const m of data.matchAll(/<option\s+value="(https?:\/\/[^"]+)"[^>]*data-host="[^"]*"/gi)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ embed: m[1] });
    }
    return out.slice(0, MAX_PER_LANG);
  } catch { return []; }
}

export async function getAnimoflixStreams(
  id: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season: number | undefined,
  episode: number | undefined,
  title: string,
  originalTitle?: string,
  altTitles: string[] = [],
): Promise<AnimoflixStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && !episode) return [];
  const s = mediaType === 'series' ? (season || 1) : 1;
  const e = mediaType === 'series' ? episode! : 1;
  const key = `animoflix:${extractorConfig.useMediaFlow ? 'mf' : 'loc'}:${id}:${s}:${e}`;
  const titles = [...new Set([title, originalTitle, ...altTitles].filter(Boolean) as string[])];
  return cached(
    key, STREAMS_TTL_MS,
    async () => { const r = await fetchAnimoflixStreams(titles, s, e, extractorConfig); return applyMultiAudio(r); },
    { scope: 'animoflix', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchAnimoflixStreams(
  titles: string[], season: number, episode: number, extractorConfig: ExtractorConfig,
): Promise<AnimoflixStream[]> {
  const slugs = [...new Set(titles.map(slugify).filter(Boolean))];

  // Trouve le slug qui existe (rend des serveurs dans au moins une langue).
  let matched: string | null = null;
  const firstHits = new Map<string, Embed[]>();   // lang.path -> embeds (évite un re-fetch)
  for (const slug of slugs) {
    for (const lang of LANGS) {
      const emb = await fetchEpisode(slug, season, lang.path, episode);
      if (emb.length) { matched = slug; firstHits.set(lang.path, emb); break; }
    }
    if (matched) break;
  }
  if (!matched) { console.log(`[Animoflix] pas de correspondance pour "${titles[0]}"`); return []; }

  // Rassemble les serveurs des 2 langues pour le slug trouvé.
  const tagged: Array<{ embed: string; language: string }> = [];
  for (const lang of LANGS) {
    const emb = firstHits.get(lang.path) ?? await fetchEpisode(matched, season, lang.path, episode);
    for (const x of emb) tagged.push({ embed: x.embed, language: lang.label });
  }

  // Dédup par hôte+langue, extraction en parallèle.
  const seen = new Set<string>();
  const streams = (await Promise.all(tagged.map(async (item): Promise<AnimoflixStream[]> => {
    const host = hostOf(item.embed);
    const dedupe = `${host}:${item.language}`;
    if (seen.has(dedupe)) return [];
    seen.add(dedupe);
    if (!detectExtractor(item.embed)) return [];
    const ex = await extractStream(item.embed, extractorConfig);
    if (!ex?.url) return [];
    return [{ url: ex.url, quality: ex.quality || 'HD', language: item.language, server: host, headers: ex.headers }];
  }))).flat();

  console.log(`[Animoflix] ${streams.length} flux pour "${titles[0]}" (${matched} S${season}E${episode})`);
  return streams;
}

/** Sonde de santé : la home expose-t-elle des fiches /anime/ ? */
export async function animoflixProbe(): Promise<boolean> {
  try {
    const { data, status } = await axios.get<string>(`${BASE()}/`, {
      headers: { 'User-Agent': UA }, timeout: REQ_TIMEOUT_MS,
      responseType: 'text', transformResponse: v => v, validateStatus: () => true, httpsAgent: agent,
    });
    return status >= 200 && status < 300 && typeof data === 'string' && data.includes('/anime/');
  } catch { return false; }
}

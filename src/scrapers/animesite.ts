import axios from 'axios';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { makeEndpointConfig } from '../endpoint-config';
import { makeDnsSafeAgent } from '../dns-resolve';
import { titlesMatch, expandTitles } from '../matching';

// AnimeSite (animesite.fr) — anime FR VF/VOSTFR, catalogue populaire et frais.
// App Next.js (TurboPack). Le défi Cloudflare « Just a moment » qui bloquait en 2026-09
// a DISPARU : axios + Referer suffit. Protocole reversé le 2026-09-30 :
//
//   Catalogue : /sitemap.xml liste 2500+ pages `/<id>-<slug>`. Le segment complet
//     `<id>-<slug>` EST l'`idAndSlugTitle` attendu par l'API de flux. On mappe le titre
//     (slugifié + alts romaji AniList) sur les slugs du sitemap. (La recherche du site est
//     rendue côté client via un fetch dynamique introuvable sans navigateur -> sitemap.)
//   Lecteurs : GET /play/<idSlug>/<s>/<e> -> boutons « Lecteur N · VF|VOSTFR|VO ».
//   Flux     : POST /api/stream/token {idAndSlugTitle, seasonNumber, episodeNumber,
//     playerIndex} AVEC en-tête Origin (garde CSRF) -> {status:"ok", kind, isHls, src:"/v/<jeton signé>"}.
//     GET /v/<jeton> (sans suivre) -> 302 Location = embed hôte tiers (sibnet/voe/uqload…)
//     à extraire, OU (kind:"direct") un flux HLS/MP4 direct.

const SITEMAP_TTL_MS = 6 * 60 * 60 * 1000;
const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const MAX_PLAYERS = 6;   // au plus 6 lecteurs sondés par épisode

const siteEndpoints = makeEndpointConfig('animesite-endpoints.json', 'ANIMESITE_ENDPOINTS_CONFIG', {
  base: 'https://animesite.fr',
});
export const reloadAnimesiteEndpoints = siteEndpoints.reload;
export const getAnimesiteEndpoints = siteEndpoints.get;
const BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const agent = makeDnsSafeAgent();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface AnimesiteStream {
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

function languageOf(label: string): string {
  const l = label.toUpperCase();
  if (l.includes('VF')) return 'VF';     // doublage
  return 'VOSTFR';                        // VOSTFR / VOST / VO (FR anime : VO = sous-titré)
}

function serverName(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/(^|\.)mail\.ru$/.test(h)) return 'mailru';
    if (/sibnet/.test(h)) return 'sibnet';
    return h.split('.')[0] || 'animesite';
  } catch { return 'animesite'; }
}

// --- Catalogue via sitemap (slug -> idAndSlugTitle) --------------------------------

interface SiteEntry { idSlug: string; slug: string; }

async function getSitemap(): Promise<SiteEntry[]> {
  return cached<SiteEntry[]>(
    'animesite:sitemap', SITEMAP_TTL_MS,
    async () => {
      try {
        const { data, status } = await axios.get<string>(`${BASE()}/sitemap.xml`, {
          headers: { 'User-Agent': UA, Referer: `${BASE()}/` },
          timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
          validateStatus: () => true, httpsAgent: agent,
        });
        if (status < 200 || status >= 300 || typeof data !== 'string') return [];
        const out: SiteEntry[] = [];
        for (const m of data.matchAll(/<loc>([^<]+)<\/loc>/g)) {
          const seg = m[1].split('/').pop() || '';
          const mm = seg.match(/^(\d+-[a-z0-9].*)$/i);       // <id>-<slug>
          if (!mm) continue;
          out.push({ idSlug: seg, slug: seg.replace(/^\d+-/, '') });
        }
        return out;
      } catch { return []; }
    },
    { scope: 'animesite', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

/** idAndSlugTitle de l'anime, par match de slug (exact d'abord, puis token-set). */
async function matchAnime(titles: string[]): Promise<string | null> {
  const entries = await getSitemap();
  if (!entries.length) return null;
  const wantedSlugs = new Set(titles.map(slugify).filter(Boolean));
  // 1. Slug EXACT (le plus fiable : les slugs du sitemap sont en romaji).
  for (const e of entries) if (wantedSlugs.has(e.slug)) return e.idSlug;
  // 2. Token-set sur le slug « déslugifié » (repli, tolère l'ordre/ponctuation).
  const wanted = expandTitles(titles);
  for (const e of entries) {
    if (titlesMatch(wanted, e.slug.replace(/-/g, ' '))) return e.idSlug;
  }
  return null;
}

// --- Lecteurs d'un épisode ---------------------------------------------------------

interface Player { index: number; lang: string; }

async function playerList(idSlug: string, season: number, episode: number): Promise<Player[]> {
  try {
    const { data, status } = await axios.get<string>(
      `${BASE()}/play/${idSlug}/${season}/${episode}`,
      {
        headers: { 'User-Agent': UA, Referer: `${BASE()}/${idSlug}` },
        timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
        validateStatus: () => true, httpsAgent: agent,
      },
    );
    if (status < 200 || status >= 300 || typeof data !== 'string') return [];
    const html = data.replace(/\\"/g, '"'); // le flight data RSC échappe les guillemets
    const out: Player[] = [];
    const seen = new Set<number>();
    // Boutons « Lecteur ",N," · ","LANG" » dans le flight data RSC.
    for (const m of html.matchAll(/"Lecteur ",(\d+)," · ","([^"]+)"/g)) {
      const idx = Number(m[1]);
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push({ index: idx, lang: languageOf(m[2]) });
    }
    return out;
  } catch { return []; }
}

// --- Résolution d'un lecteur -> URL jouable ----------------------------------------

interface TokenResp { status?: string; kind?: string; isHls?: boolean; src?: string; }

async function resolvePlayer(
  idSlug: string, season: number, episode: number, index: number,
): Promise<{ url: string; isEmbed: boolean } | null> {
  let tok: TokenResp;
  try {
    const r = await axios.post<TokenResp>(
      `${BASE()}/api/stream/token`,
      { idAndSlugTitle: idSlug, seasonNumber: String(season), episodeNumber: String(episode), playerIndex: index },
      {
        headers: {
          'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json',
          Origin: BASE(), Referer: `${BASE()}/play/${idSlug}/${season}/${episode}`,
        },
        timeout: REQ_TIMEOUT_MS, validateStatus: () => true, httpsAgent: agent,
      },
    );
    tok = r.data || {};
    if (tok.status !== 'ok' || !tok.src) return null;
  } catch { return null; }

  // src = /v/<jeton signé> -> 302 vers l'embed/flux réel (on NE suit PAS le redirect).
  const vUrl = /^https?:\/\//i.test(tok.src) ? tok.src : `${BASE()}${tok.src}`;
  try {
    const r = await axios.get(vUrl, {
      headers: { 'User-Agent': UA, Referer: `${BASE()}/play/${idSlug}/${season}/${episode}` },
      timeout: REQ_TIMEOUT_MS, maxRedirects: 0, validateStatus: () => true, httpsAgent: agent,
    });
    const loc = r.headers?.location as string | undefined;
    const target = loc && /^https?:\/\//i.test(loc) ? loc : vUrl;
    // kind:"direct" -> flux direct (HLS/MP4) ; sinon embed hôte tiers à extraire.
    return { url: target, isEmbed: tok.kind !== 'direct' };
  } catch { return null; }
}

// --- Point d'entrée ----------------------------------------------------------------

export async function getAnimesiteStreams(
  id: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season: number | undefined,
  episode: number | undefined,
  title: string,
  originalTitle?: string,
  altTitles: string[] = [],
): Promise<AnimesiteStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && !episode) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const s = mediaType === 'series' ? (season || 1) : 1;
  const e = mediaType === 'series' ? episode! : 1;
  const key = `animesite:${mode}:${id}:${s}:${e}`;
  const titles = [...new Set([...altTitles, originalTitle, title].filter(Boolean) as string[])];
  return cached(
    key, STREAMS_TTL_MS,
    async () => { const r = await fetchAnimesiteStreams(titles, s, e, extractorConfig); return applyMultiAudio(r); },
    { scope: 'animesite', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchAnimesiteStreams(
  titles: string[], season: number, episode: number, extractorConfig: ExtractorConfig,
): Promise<AnimesiteStream[]> {
  const idSlug = await matchAnime(titles);
  if (!idSlug) { console.log(`[AnimeSite] pas de correspondance pour "${titles[0]}"`); return []; }

  const players = (await playerList(idSlug, season, episode)).slice(0, MAX_PLAYERS);
  if (!players.length) { console.log(`[AnimeSite] aucun lecteur pour ${idSlug} S${season}E${episode}`); return []; }

  const resolved = await Promise.all(players.map(async p => {
    const r = await resolvePlayer(idSlug, season, episode, p.index);
    return r ? { ...r, lang: p.lang } : null;
  }));

  // Dédup par hôte, extraction en parallèle.
  const seenHost = new Set<string>();
  const streams = (await Promise.all(resolved.map(async (item): Promise<AnimesiteStream[]> => {
    if (!item) return [];
    const host = serverName(item.url);
    if (seenHost.has(host)) return [];
    seenHost.add(host);
    if (item.isEmbed) {
      if (!detectExtractor(item.url)) return [];
      const ex = await extractStream(item.url, extractorConfig);
      if (!ex?.url) return [];
      return [{ url: ex.url, quality: ex.quality || 'HD', language: item.lang, server: host, headers: ex.headers }];
    }
    // Flux direct (HLS/MP4) servi par animesite.
    return [{ url: item.url, quality: 'HD', language: item.lang, server: 'direct', headers: { Referer: `${BASE()}/` } }];
  }))).flat();

  console.log(`[AnimeSite] ${streams.length} flux pour "${titles[0]}" (${idSlug})`);
  return streams;
}

/** Sonde de santé : le sitemap répond-il avec des pages anime ? */
export async function animesiteProbe(): Promise<boolean> {
  return (await getSitemap()).length > 0;
}

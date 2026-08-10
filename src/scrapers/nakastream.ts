import axios from 'axios';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';

// nakastream.tv — agrégateur keyé TMDB (films / séries / anime, catalogue large,
// blockbusters inclus). Re-héberge sur son R2 un HLS DIRECT tokené (FR audio DEFAULT,
// ~720p) + sous-titres FR/EN (WebVTT). Auth = Bearer token PER-USER obtenu par PAIRING
// (code claim, cf. endpoint /api/nakastream/claim). Le token du flux/subs vit ~6h ->
// aucun 401 en cours de lecture. Résolution FIABLE = browse/search + match par tmdbId
// (l'endpoint by-tmdb est CASSÉ, ne pas l'utiliser).
//
// Flow (header Authorization: Bearer <token>) :
//   Search : /browse/search?q=<title> -> [{id, tmdbId, mediaType}] -> match tmdbId
//   Stream : /streaming/source/<id>[?season=&episode=] -> { url:master.m3u8?token, subtitles[], audioTracks[] }

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 12000;

const endpoints = makeEndpointConfig('nakastream-endpoints.json', 'NAKASTREAM_ENDPOINTS_CONFIG', {
  base: 'https://nakastream.tv',
});
export const reloadNakastreamEndpoints = endpoints.reload;
export const getNakastreamEndpoints = endpoints.get;
const BASE = () => endpoints.get().base.replace(/\/+$/, '');
const API = () => `${BASE()}/api/v1`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Token nakastream invalide/expiré (session device révoquée) -> le handler affiche une
 *  entrée « reconnecte » NON-bloquante (les autres sources continuent). */
export class NakastreamAuthError extends Error {
  constructor() { super('nakastream token invalide/expiré'); this.name = 'NakastreamAuthError'; }
}

export interface NakastreamStream {
  url: string;
  quality: string;
  language: string;
  server: string;
  subtitles: { lang: string; url: string }[];
}

function authHeaders(token: string) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': `${BASE()}/`,
    'Authorization': `Bearer ${token}`,
  };
}

// GET JSON authentifié, 1 retry sur échec DNS (nakastream.tv a montré des ENOTFOUND
// transitoires sur ce serveur). Renvoie {status, data} (status 0 = échec réseau).
async function getJson<T = any>(url: string, token: string): Promise<{ status: number; data: T | null }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, status } = await axios.get(url, { headers: authHeaders(token), timeout: REQ_TIMEOUT_MS, validateStatus: () => true });
      return { status, data: (data && typeof data === 'object') ? (data as T) : null };
    } catch (e: any) {
      const dns = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT/.test(String(e?.code || e?.message || ''));
      if (dns && attempt === 0) { await new Promise(r => setTimeout(r, 600)); continue; }
      return { status: 0, data: null };
    }
  }
  return { status: 0, data: null };
}

// nakastream renvoie déjà de l'ISO 639-2 (fre/eng) ; repli minimal 2->3.
function subLang(lang: string): string {
  const l = (lang || '').toLowerCase();
  return ({ fr: 'fre', en: 'eng' } as Record<string, string>)[l] || l;
}

// Qualité réelle depuis le master (RESOLUTION) — valide aussi la vivacité. 'HD' en repli.
async function masterQuality(masterUrl: string): Promise<string> {
  try {
    const { data } = await axios.get<string>(masterUrl, {
      headers: { 'User-Agent': UA, 'Referer': `${BASE()}/` }, timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
    });
    const h = String(data).match(/RESOLUTION=\d+x(\d+)/i);
    if (!h) return 'HD';
    const height = Number(h[1]);
    if (height >= 2000) return '4K';
    if (height >= 1000) return '1080p';
    if (height >= 700) return '720p';
    if (height >= 460) return '480p';
    return 'HD';
  } catch { return 'HD'; }
}

// Résout l'id interne via search + match par tmdbId (by-tmdb est cassé).
async function resolveContentId(token: string, tmdbId: string, title: string, wantTv: boolean): Promise<string | null> {
  const { status, data } = await getJson<any>(`${API()}/browse/search?q=${encodeURIComponent(title)}`, token);
  if (status === 401) throw new NakastreamAuthError();
  const arr: any[] = data?.data || data?.results || (Array.isArray(data) ? data : []);
  const want = wantTv ? 'tv' : 'movie';
  const hit = arr.find(c => String(c.tmdbId) === String(tmdbId) && c.mediaType === want)
    || arr.find(c => String(c.tmdbId) === String(tmdbId));
  return hit ? String(hit.id) : null;
}

export async function getNakastreamStreams(
  token: string | undefined,
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  title?: string,
): Promise<NakastreamStream[]> {
  if (!token || !tmdbId || !title) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const key = `nakastream:${tmdbId}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchNakastreamStreams(token, tmdbId, mediaType, season, episode, title!),
    { scope: 'nakastream', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchNakastreamStreams(
  token: string,
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season: number | undefined,
  episode: number | undefined,
  title: string,
): Promise<NakastreamStream[]> {
  const contentId = await resolveContentId(token, tmdbId, title, mediaType === 'series');
  if (!contentId) { console.log(`[Nakastream] Hors catalogue (tmdb ${tmdbId})`); return []; }

  let url = `${API()}/streaming/source/${encodeURIComponent(contentId)}`;
  if (mediaType === 'series') url += `?season=${season}&episode=${episode}`;
  const { status, data } = await getJson<any>(url, token);
  if (status === 401) throw new NakastreamAuthError();
  const master = data?.url;
  if (!master || typeof master !== 'string') { console.log(`[Nakastream] Pas de source (tmdb ${tmdbId})`); return []; }
  const masterUrl = /^https?:\/\//.test(master) ? master : `${BASE()}${master}`;

  const audio: any[] = Array.isArray(data?.audioTracks) ? data.audioTracks : [];
  const language = audio.length >= 2 ? 'MULTI' : (audio.some((a: any) => /fr/i.test(a?.lang)) ? 'VF' : 'VOSTFR');

  // Sous-titres (WebVTT) — dédoublonnés par langue (nakastream renvoie parfois 2x la même).
  const seen = new Set<string>();
  const subtitles = (Array.isArray(data?.subtitles) ? data.subtitles : [])
    .filter((s: any) => s?.url && s?.lang)
    .map((s: any) => ({ lang: subLang(s.lang), url: /^https?:\/\//.test(s.url) ? s.url : `${BASE()}${s.url}` }))
    .filter((s: { lang: string }) => { if (seen.has(s.lang)) return false; seen.add(s.lang); return true; });

  const quality = await masterQuality(masterUrl);
  console.log(`[Nakastream] tmdb ${tmdbId} -> ${quality} ${language} (${subtitles.length} sub)`);
  return [{ url: masterUrl, quality, language, server: 'nakastream', subtitles }];
}

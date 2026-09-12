import axios from 'axios';
import * as crypto from 'crypto';
import { cached } from '../cache';
import { curlJson, isCloudflareChallenge } from '../curl-fetch';
import { makeEndpointConfig } from '../endpoint-config';

// nkstrm.tv — agrégateur keyé TMDB (films / séries / anime, catalogue large,
// blockbusters inclus). Re-héberge sur son R2 un HLS DIRECT tokené (FR audio DEFAULT,
// ~720p) + sous-titres FR/EN (WebVTT). Auth = Bearer token PER-USER obtenu par PAIRING
// (code claim, cf. endpoint /api/nkstrm/claim). Le token du flux/subs vit ~6h ->
// aucun 401 en cours de lecture. Résolution FIABLE = browse/search + match par tmdbId
// (l'endpoint by-tmdb est CASSÉ, ne pas l'utiliser).
//
// Flow (header Authorization: Bearer <token>) :
//   Search : /browse/search?q=<title> -> [{id, tmdbId, mediaType}] -> match tmdbId
//   Stream : /streaming/source/<id>[?season=&episode=] -> { url:master.m3u8?token, subtitles[], audioTracks[] }

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 12000;

const endpoints = makeEndpointConfig('nkstrm-endpoints.json', 'NKSTRM_ENDPOINTS_CONFIG', {
  base: 'https://naka.cx',
});
export const reloadNkstrmEndpoints = endpoints.reload;
export const getNkstrmEndpoints = endpoints.get;
const BASE = () => endpoints.get().base.replace(/\/+$/, '');
const API = () => `${BASE()}/api/v1`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Token nkstrm invalide/expiré (session device révoquée) -> le handler affiche une
 *  entrée « reconnecte » NON-bloquante (les autres sources continuent). */
export class NkstrmAuthError extends Error {
  constructor() { super('nkstrm token invalide/expiré'); this.name = 'NkstrmAuthError'; }
}

export interface NkstrmStream {
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

// GET JSON authentifié, via CURL et non axios : depuis le 2026-09-12 Cloudflare rend
// un défi « Just a moment » (403) à toute requête Node vers leur domaine, alors que curl
// passe — cf. src/curl-fetch.ts pour la mesure. On garde le retry sur échec réseau
// (status 0), qui couvre aussi le cas « curl absent de l'image ».
async function getJson<T = any>(url: string, token: string): Promise<{ status: number; data: T | null }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, data, body } = await curlJson<T>(url, { headers: authHeaders(token), timeoutMs: REQ_TIMEOUT_MS });
    if (status === 0 && attempt === 0) { await new Promise(r => setTimeout(r, 600)); continue; }
    if (isCloudflareChallenge(body, status)) {
      console.log('[Nkstrm] défi Cloudflare — le serveur est bloqué par leur anti-bot');
      return { status: 403, data: null };
    }
    return { status, data };
  }
  return { status: 0, data: null };
}

// nkstrm renvoie déjà de l'ISO 639-2 (fre/eng) ; repli minimal 2->3.
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
  if (status === 401) throw new NkstrmAuthError();
  const arr: any[] = data?.data || data?.results || (Array.isArray(data) ? data : []);
  const want = wantTv ? 'tv' : 'movie';
  const hit = arr.find(c => String(c.tmdbId) === String(tmdbId) && c.mediaType === want)
    || arr.find(c => String(c.tmdbId) === String(tmdbId));
  return hit ? String(hit.id) : null;
}

export async function getNkstrmStreams(
  token: string | undefined,
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  title?: string,
): Promise<NkstrmStream[]> {
  if (!token || !tmdbId || !title) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  // Clé PAR TOKEN (hash court) : chaque user a sa propre entrée (le master est tokené
  // par session) -> pas de partage inter-user, et un token invalide résout à part (401).
  const tHash = crypto.createHash('md5').update(token).digest('hex').slice(0, 8);
  const key = `nkstrm:${tHash}:${tmdbId}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchNkstrmStreams(token, tmdbId, mediaType, season, episode, title!),
    { scope: 'nkstrm', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchNkstrmStreams(
  token: string,
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season: number | undefined,
  episode: number | undefined,
  title: string,
): Promise<NkstrmStream[]> {
  const contentId = await resolveContentId(token, tmdbId, title, mediaType === 'series');
  if (!contentId) { console.log(`[Nkstrm] Hors catalogue (tmdb ${tmdbId})`); return []; }

  let url = `${API()}/streaming/source/${encodeURIComponent(contentId)}`;
  if (mediaType === 'series') url += `?season=${season}&episode=${episode}`;
  const { status, data } = await getJson<any>(url, token);
  if (status === 401) throw new NkstrmAuthError();
  const master = data?.url;
  if (!master || typeof master !== 'string') { console.log(`[Nkstrm] Pas de source (tmdb ${tmdbId})`); return []; }
  const masterUrl = /^https?:\/\//.test(master) ? master : `${BASE()}${master}`;

  const audio: any[] = Array.isArray(data?.audioTracks) ? data.audioTracks : [];
  const language = audio.length >= 2 ? 'MULTI' : (audio.some((a: any) => /fr/i.test(a?.lang)) ? 'VF' : 'VOSTFR');

  // Sous-titres (WebVTT) — dédoublonnés par langue (nkstrm renvoie parfois 2x la même).
  const seen = new Set<string>();
  const subtitles = (Array.isArray(data?.subtitles) ? data.subtitles : [])
    .filter((s: any) => s?.url && s?.lang)
    .map((s: any) => ({ lang: subLang(s.lang), url: /^https?:\/\//.test(s.url) ? s.url : `${BASE()}${s.url}` }))
    .filter((s: { lang: string }) => { if (seen.has(s.lang)) return false; seen.add(s.lang); return true; });

  const quality = await masterQuality(masterUrl);
  console.log(`[Nkstrm] tmdb ${tmdbId} -> ${quality} ${language} (${subtitles.length} sub)`);
  return [{ url: masterUrl, quality, language, server: 'nkstrm', subtitles }];
}

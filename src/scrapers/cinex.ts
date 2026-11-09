import axios from 'axios';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';
import { makeDnsSafeAgent } from '../dns-resolve';

// Cinex (cinex.buzz) — agrégateur FR keyé TMDB, API JSON OUVERTE (sans compte ni captcha).
// Protocole reversé le 2026-11-09 :
//   GET /api/streaming/movie/<tmdbId>                       -> [{url,lang,provider,country,...}]
//   GET /api/streaming/tv/<tmdbId>?season=<s>&episode=<e>   -> idem
//
// On ne garde que la ou les sources FR (lang VF/VOSTFR, provider « CINEX ») ; les autres
// entrées sont des farms VO (SuperEmbed/Videasy/VidLink/VidSrc) qu'on couvre déjà ailleurs.
//   • Films  : MP4 direct zen-blk -> 302 -> falzey (le MÊME backend qui 403 sur StreamFlix,
//     mais l'entrée zen-blk de cinex, elle, DÉLIVRE). GATÉ sur `Referer: https://cinex.buzz/`
//     (strict : sans lui, ou autre referer -> page de blocage). Pas de token ni d'IP-lock
//     -> stable (pas d'expiration).
//   • Séries : HLS via /api/m3u8-proxy?url=<b64 finepulfe> (proxy HLS de cinex).
//
// LIVRAISON : on pose `Referer: cinex.buzz` en proxyHeaders et on laisse DIRECTABLE. Nuvio
// propage le referer (leçon fsvid, cf. nuvio_direct_host_map) -> lecture directe, 0 bande
// passante serveur. Si un jour Nuvio ne le propage pas (TV…), basculer zen-blk/falzey en
// PROXY_FORCED_HOSTS (deliver.ts) -> MFP.

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;

const siteEndpoints = makeEndpointConfig('cinex-endpoints.json', 'CINEX_ENDPOINTS_CONFIG', {
  base: 'https://cinex.buzz',
});
export const reloadCinexEndpoints = siteEndpoints.reload;
export const getCinexEndpoints = siteEndpoints.get;
const BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const agent = makeDnsSafeAgent();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface CinexStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR
  server: string;
  headers: Record<string, string>;   // Referer cinex (gate strict)
}

interface CinexSource {
  url?: string; lang?: string; provider?: string; country?: string; quality?: string; type?: string;
}

function languageOf(lang: string): string | null {
  const l = (lang || '').toUpperCase();
  if (l.includes('VOSTFR') || l.includes('VOST')) return 'VOSTFR';
  if (l === 'VF' || l.includes('FRENCH') || l === 'VFF') return 'VF';
  return null; // VO et autres -> écartés (farms VO déjà couvertes ailleurs)
}

function serverName(url: string): string {
  try {
    const h = new URL(url, BASE()).hostname.replace(/^www\./, '');
    if (/finepulfe/.test(h)) return 'finepulfe';
    if (/zen-blk|falzey/.test(h)) return 'zen-blk';
    if (h.includes('cinex')) return 'cinex';
    return h.split('.')[0] || 'cinex';
  } catch { return 'cinex'; }
}

export async function getCinexStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
): Promise<CinexStream[]> {
  if (!tmdbId) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const key = mediaType === 'series'
    ? `cinex:tv:${tmdbId}:${season}:${episode}`
    : `cinex:movie:${tmdbId}`;
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchCinexStreams(tmdbId, mediaType, season, episode),
    { scope: 'cinex', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchCinexStreams(
  tmdbId: string, mediaType: 'movie' | 'series', season?: number, episode?: number,
): Promise<CinexStream[]> {
  const path = mediaType === 'series'
    ? `/api/streaming/tv/${tmdbId}?season=${season}&episode=${episode}`
    : `/api/streaming/movie/${tmdbId}`;
  let list: CinexSource[];
  try {
    const { data, status } = await axios.get<CinexSource[]>(`${BASE()}${path}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${BASE()}/` },
      timeout: REQ_TIMEOUT_MS, validateStatus: () => true, httpsAgent: agent,
    });
    if (status < 200 || status >= 300 || !Array.isArray(data)) return [];
    list = data;
  } catch { return []; }

  const seen = new Set<string>();
  const out: CinexStream[] = [];
  for (const s of list) {
    const lang = languageOf(s.lang || '');
    if (!lang || !s.url) continue;                       // on ne garde que VF/VOSTFR
    const url = /^https?:\/\//i.test(s.url) ? s.url : `${BASE()}${s.url}`;
    const host = serverName(url);
    const dedupe = `${host}:${lang}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      url, quality: s.quality || 'HD', language: lang, server: host,
      headers: { Referer: `${BASE()}/` },               // gate strict falzey/finepulfe
    });
  }
  console.log(`[Cinex] ${out.length} flux FR pour tmdb ${tmdbId} (${mediaType})`);
  return out;
}

/** Sonde de santé : l'API streaming répond-elle du JSON ? */
export async function cinexProbe(): Promise<boolean> {
  try {
    const { data, status } = await axios.get(`${BASE()}/api/streaming/movie/1368337`, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${BASE()}/` },
      timeout: REQ_TIMEOUT_MS, validateStatus: () => true, httpsAgent: agent,
    });
    return status >= 200 && status < 300 && Array.isArray(data);
  } catch { return false; }
}

import axios from 'axios';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';
import { makeDnsSafeAgent } from '../dns-resolve';
import { probeHlsResolution } from '../hls-resolution';

// Miaw (miaw.tv) — gros agrégateur FR (films/séries/animés), API JSON OUVERTE keyée TMDB,
// VF ET VOSTFR. Protocole reversé le 2026-11-10 :
//   GET /api/watch/movie/<tmdbId>
//   GET /api/watch/series/<tmdbId>?season=<s>&episode=<e>
//     -> { data:{ players:[{ type, language, src, ... }] } }
//
// Lecteurs gardés (VF/VOSTFR) :
//   • blink  (lecteur natif miaw) : src = miaw.tv/api/blink/v/<JWT court> -> 302 -> zen-blk
//     -> 302 -> zen-blk/...mp4?ff=<signé>. On renvoie l'URL /api/blink/v TELLE QUELLE
//     (hôte miaw.tv, donc DIRECTABLE ; re-forge un ?ff frais à chaque accès -> pas d'URL
//     signée à cacher). L'URL ?ff joue SANS referer (206) ; seul un referer ÉTRANGER la
//     casse (403) -> on NE pose PAS de referer -> direct-first. Si Nuvio ne suit pas le 302
//     ou si le ?ff est IP-lié -> basculer miaw.tv en PROXY_FORCED_HOSTS (deliver.ts).
//   • vidzy  : src = vidzy.org/.../<lang> -> extractStream (extracteur vidzy existant).
//   • source : src = sharecloudy.com/iframe/<id> -> extractStream (famille sharecloudy).
// (moviez / uqload : à ajouter plus tard si besoin.)

const STREAMS_TTL_MS = 10 * 60 * 1000;   // court : les JWT blink sont de durée limitée
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;

const siteEndpoints = makeEndpointConfig('miaw-endpoints.json', 'MIAW_ENDPOINTS_CONFIG', {
  base: 'https://miaw.tv',
});
export const reloadMiawEndpoints = siteEndpoints.reload;
export const getMiawEndpoints = siteEndpoints.get;
const BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const agent = makeDnsSafeAgent();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface MiawStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR
  server: string;
  headers?: Record<string, string>;
}

interface Player { type?: string; language?: string; src?: string; }

function languageOf(lang: string): string | null {
  const l = (lang || '').toLowerCase();
  if (l === 'vostfr' || l === 'vost') return 'VOSTFR';
  if (l === 'vf') return 'VF';
  return null; // VO / autres -> écartés
}

function hostName(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/vidzy/.test(h)) return 'vidzy';
    if (/sharecloudy|moovbob|moovtop/.test(h)) return 'sharecloudy';
    if (/miaw/.test(h)) return 'miaw';
    return h.split('.')[0] || 'miaw';
  } catch { return 'miaw'; }
}

export async function getMiawStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season?: number,
  episode?: number,
): Promise<MiawStream[]> {
  if (!tmdbId) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = mediaType === 'series'
    ? `miaw:${mode}:tv:${tmdbId}:${season}:${episode}`
    : `miaw:${mode}:movie:${tmdbId}`;
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchMiawStreams(tmdbId, mediaType, extractorConfig, season, episode),
    { scope: 'miaw', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchMiawStreams(
  tmdbId: string, mediaType: 'movie' | 'series', extractorConfig: ExtractorConfig,
  season?: number, episode?: number,
): Promise<MiawStream[]> {
  const path = mediaType === 'series'
    ? `/api/watch/series/${tmdbId}?season=${season}&episode=${episode}`
    : `/api/watch/movie/${tmdbId}`;
  let players: Player[];
  try {
    const { data, status } = await axios.get<any>(`${BASE()}${path}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${BASE()}/` },
      timeout: REQ_TIMEOUT_MS, validateStatus: () => true, httpsAgent: agent,
    });
    if (status < 200 || status >= 300) return [];
    players = data?.data?.players;
    if (!Array.isArray(players)) return [];
  } catch { return []; }

  const seen = new Set<string>();
  const results = await Promise.all(players.map(async (p): Promise<MiawStream[]> => {
    const lang = languageOf(p.language || '');
    if (!lang || !p.src) return [];

    if (p.type === 'blink') {
      // Lecteur natif miaw : URL /api/blink/v (miaw.tv) directable, pas de referer -> direct-first.
      const dedupe = `miaw:${lang}`;
      if (seen.has(dedupe)) return [];
      seen.add(dedupe);
      // PAS de sonde de résolution : fetcher /api/blink/v côté serveur à chaque requête
      // déclenchait l'anti-abus du backend (rate-limit du blink/token -> lecture cassée,
      // y compris pour le client). La lecture prime sur l'affichage de la résolution -> « HD ».
      return [{ url: p.src, quality: 'HD', language: lang, server: 'miaw' }];
    }

    // vidzy / sharecloudy -> extracteurs existants.
    if (!detectExtractor(p.src)) return [];
    const host = hostName(p.src);
    const dedupe = `${host}:${lang}`;
    if (seen.has(dedupe)) return [];
    seen.add(dedupe);
    const ex = await extractStream(p.src, extractorConfig);
    if (!ex?.url) return [];
    // Résolution RÉELLE pour les m3u8 (sharecloudy/vidzy) : on lit le SPS du 1er segment TS
    // sur le CDN (comme Kordoz). SÛR, contrairement au blink : c'est le CDN, pas l'endpoint à
    // jeton anti-abus. Bonus : écarte les flux morts (404/403).
    let quality = ex.quality || 'HD';
    if (/\.m3u8/i.test(ex.url)) {
      const probe = await probeHlsResolution(ex.url, ex.headers || {});
      if (probe.dead) return [];
      if (probe.quality) quality = probe.quality;
    }
    return [{ url: ex.url, quality, language: lang, server: host, headers: ex.headers }];
  }));

  const streams = results.flat();
  console.log(`[Miaw] ${streams.length} flux FR pour tmdb ${tmdbId} (${mediaType})`);
  return streams;
}

/** Sonde de santé : l'API watch répond-elle avec des lecteurs ? */
export async function miawProbe(): Promise<boolean> {
  try {
    const { data, status } = await axios.get<any>(`${BASE()}/api/watch/movie/1263337`, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${BASE()}/` },
      timeout: REQ_TIMEOUT_MS, validateStatus: () => true, httpsAgent: agent,
    });
    return status >= 200 && status < 300 && Array.isArray(data?.data?.players);
  } catch { return false; }
}

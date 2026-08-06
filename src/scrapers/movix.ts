import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { isStreamLive } from '../live-check';

const STREAMS_TTL_MS = 15 * 60 * 1000;

interface MovixEndpoints {
  api: string;
  referer: string;
  origin: string;
}

const DEFAULT_ENDPOINTS: MovixEndpoints = {
  api: 'https://api.movix.cash',
  referer: 'https://movix.cash/',
  origin: 'https://movix.cash',
};

const ENDPOINTS_PATH = process.env.MOVIX_ENDPOINTS_CONFIG ||
  (fs.existsSync('/app/config/movix-endpoints.json')
    ? '/app/config/movix-endpoints.json'
    : path.join(process.cwd(), 'config', 'movix-endpoints.json'));

let endpoints: MovixEndpoints = { ...DEFAULT_ENDPOINTS };

function loadEndpoints(): void {
  try {
    if (fs.existsSync(ENDPOINTS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(ENDPOINTS_PATH, 'utf-8'));
      if (raw.api && raw.referer && raw.origin) {
        endpoints = { api: raw.api, referer: raw.referer, origin: raw.origin };
        console.log(`[Movix] Endpoints loaded: api=${endpoints.api}`);
        return;
      }
    }
  } catch (e: any) {
    console.error(`[Movix] Error loading endpoints: ${e.message}`);
  }
  endpoints = { ...DEFAULT_ENDPOINTS };
  console.log(`[Movix] Using default endpoints: api=${endpoints.api}`);
}

export function reloadMovixEndpoints(): MovixEndpoints {
  loadEndpoints();
  return { ...endpoints };
}

export function getMovixEndpoints(): MovixEndpoints {
  return { ...endpoints };
}

loadEndpoints();

try {
  if (fs.existsSync(ENDPOINTS_PATH)) {
    fs.watch(ENDPOINTS_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[Movix] Endpoints file changed, reloading...');
        setTimeout(loadEndpoints, 100);
      }
    });
  }
} catch {
  // watch not supported
}

function buildHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': endpoints.referer,
    'Origin': endpoints.origin,
  };
}

// Headers pour les SOURCES PurStream (CDN finepulfe/pulse), à NE PAS confondre avec
// ceux de l'API : leur Cloudflare BLOQUE le `Referer: movix.cash` (périmé — movix a
// migré vers .fun). PROUVÉ : Referer movix.cash -> 403 (page « Attention Required! ») ;
// UA navigateur complet SANS ce referer -> 200 (vrai manifeste MULTI). On sert donc le
// m3u8 CDN avec un UA complet et AUCUN referer movix — pour la vérif de vie ET la livraison.
function purstreamSourceHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'fr-FR,fr;q=0.9',
  };
}

/**
 * Le master PurStream déclare un groupe AUDIO ALTERNÉ (`audio_fr`/`audio_en`) sur une
 * variante qui contient DÉJÀ l'audio muxé (PID vidéo+audio dans le même .ts). Ce HLS
 * ambigu casse le rendu vidéo sur ExoPlayer/Nuvio (on entend le son, pas d'image). On
 * contourne en livrant directement la MEILLEURE VARIANTE (auto-suffisante, A/V muxés)
 * au lieu du master -> plus de groupe alterné conflictuel. Renvoie {url, quality} ou
 * null (pas un master / échec -> on garde le master en repli).
 */
async function resolvePurstreamVariant(
  masterUrl: string,
  headers: Record<string, string>,
): Promise<{ url: string; quality?: string } | null> {
  try {
    const { data } = await axios.get<string>(masterUrl, {
      headers, timeout: 10000, responseType: 'text', transformResponse: r => r,
    });
    const text = String(data || '');
    if (!/#EXT-X-STREAM-INF/i.test(text)) return null; // déjà une media playlist
    const base = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
    const lines = text.split('\n');
    let best: { url: string; height: number; bw: number; res?: string } | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF/i.test(lines[i].trim())) continue;
      const uri = (lines[i + 1] || '').trim();
      if (!uri || uri.startsWith('#')) continue;
      const resM = lines[i].match(/RESOLUTION=(\d+)x(\d+)/i);
      const bw = parseInt(lines[i].match(/BANDWIDTH=(\d+)/i)?.[1] || '0', 10);
      const height = resM ? parseInt(resM[2], 10) : 0;
      const abs = /^https?:\/\//i.test(uri) ? uri : new URL(uri, base).toString();
      if (!best || height > best.height || (height === best.height && bw > best.bw)) {
        best = { url: abs, height, bw, res: resM ? `${resM[2]}p` : undefined };
      }
    }
    return best ? { url: best.url, quality: best.res } : null;
  } catch {
    return null;
  }
}

export interface MovixStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  language: string;
  format: string;
  headers?: Record<string, string>;
  server?: string;
}

function extractQuality(name: string): string {
  if (name.includes('1080')) return '1080p';
  if (name.includes('720')) return '720p';
  if (name.includes('480')) return '480p';
  if (name.includes('4K') || name.includes('2160')) return '4K';
  return 'HD';
}

function extractLanguage(name: string): string {
  const nameLower = name.toLowerCase();
  if (nameLower.includes('vostfr')) return 'VOSTFR';
  if (nameLower.includes('vf')) return 'VF';
  if (nameLower.includes('multi')) return 'MULTI';
  if (nameLower.includes('french')) return 'VF';
  return 'VO';
}

// API 1: Purstream - direct m3u8
async function fetchPurstream(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<MovixStream[]> {
  const url = mediaType === 'series'
    ? `${endpoints.api}/api/purstream/tv/${tmdbId}/stream?season=${season || 1}&episode=${episode || 1}`
    : `${endpoints.api}/api/purstream/movie/${tmdbId}/stream`;

  console.log(`[Movix] Purstream: ${url}`);

  try {
    const { data } = await axios.get(url, { headers: buildHeaders(), timeout: 10000 });

    if (!data || !data.sources || !Array.isArray(data.sources)) {
      return [];
    }

    const srcHeaders = purstreamSourceHeaders();
    const rawCandidates: MovixStream[] = data.sources
      .filter((source: any) => source?.url)
      .map((source: any) => ({
        name: 'Movix',
        title: source.name || 'Movix VF',
        url: source.url,
        quality: extractQuality(source.name || ''),
        language: extractLanguage(source.name || ''),
        format: source.format || 'm3u8',
        server: (source.name || '').split('|')[0].trim().toLowerCase() || 'purstream',
        headers: srcHeaders, // CDN Cloudflare : UA complet, PAS de referer movix
      }));

    // Master -> meilleure variante auto-suffisante (contourne le groupe audio alterné
    // qui casse la vidéo sur Nuvio). En repli, on garde le master tel quel.
    const candidates: MovixStream[] = await Promise.all(rawCandidates.map(async c => {
      if (c.format !== 'm3u8' && !/\.m3u8(\?|$)/i.test(c.url)) return c;
      const v = await resolvePurstreamVariant(c.url, srcHeaders);
      return v ? { ...c, url: v.url, quality: v.quality || c.quality } : c;
    }));

    // The API answering 200 does not mean the CDN still serves the file: it has
    // returned URLs to a dead bucket (404 / 403 WAF) while reporting success.
    // Those play as a black screen, and since Purstream is tagged MULTI/1080p it
    // sorts first — so it is exactly the one the user clicks. Verify before
    // offering it.
    const liveness = await Promise.all(
      candidates.map(c => isStreamLive(c.url, {
        isHls: c.format === 'm3u8' || /\.m3u8(\?|$)/i.test(c.url),
        headers: c.headers, // headers CDN (sans referer movix) — sinon 403 Cloudflare
      }))
    );
    const live = candidates.filter((_, i) => liveness[i]);
    const dropped = candidates.length - live.length;
    if (dropped > 0) {
      console.log(`[Movix] Purstream: ${dropped}/${candidates.length} source(s) morte(s), écartée(s)`);
    }
    return live;
  } catch (e) {
    console.log('[Movix] Purstream failed:', e);
    return [];
  }
}

interface CpasmalLink {
  server: string;
  url: string;
  language: string;
}

// API 2: Cpasmal - VF/VOSTFR sources (returns raw embed URLs)
async function fetchCpasmal(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<CpasmalLink[]> {
  const url = mediaType === 'series'
    ? `${endpoints.api}/api/cpasmal/tv/${tmdbId}/${season || 1}/${episode || 1}`
    : `${endpoints.api}/api/cpasmal/movie/${tmdbId}`;

  console.log(`[Movix] Cpasmal: ${url}`);

  try {
    const { data } = await axios.get(url, { headers: buildHeaders(), timeout: 10000 });

    if (!data || !data.links) {
      return [];
    }

    const links: CpasmalLink[] = [];
    const langs = ['vf', 'vostfr'];

    for (const lang of langs) {
      if (data.links[lang] && Array.isArray(data.links[lang])) {
        for (const link of data.links[lang]) {
          if (link.url) {
            links.push({
              server: link.server || 'unknown',
              url: link.url,
              language: lang.toUpperCase(),
            });
          }
        }
      }
    }

    return links;
  } catch (e) {
    console.log('[Movix] Cpasmal failed:', e);
    return [];
  }
}

// API 3: FStream — VFQ/VFF/VOSTFR embeds
async function fetchFStream(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<CpasmalLink[]> {
  const url = mediaType === 'series'
    ? `${endpoints.api}/api/fstream/tv/${tmdbId}/${season || 1}/${episode || 1}`
    : `${endpoints.api}/api/fstream/movie/${tmdbId}`;

  console.log(`[Movix] FStream: ${url}`);

  try {
    const { data } = await axios.get(url, { headers: buildHeaders(), timeout: 10000 });
    if (!data?.players) return [];

    const bucketToLang: Record<string, string> = { VFQ: 'VF', VFF: 'VF', VOSTFR: 'VOSTFR' };
    const links: CpasmalLink[] = [];

    for (const [bucket, lang] of Object.entries(bucketToLang)) {
      const items = data.players[bucket];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item?.url) {
          links.push({
            server: (item.player || 'unknown').toLowerCase(),
            url: item.url,
            language: lang,
          });
        }
      }
    }
    return links;
  } catch (e) {
    console.log('[Movix] FStream failed:', e);
    return [];
  }
}

export async function getMovixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  extractorConfig?: ExtractorConfig
): Promise<MovixStream[]> {
  const mode = extractorConfig?.useMediaFlow ? 'mf' : 'loc';
  const key = `movix:${mode}:${mediaType}:${tmdbId}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    async () => { const s = await fetchMovixStreams(tmdbId, mediaType, season, episode, extractorConfig); return applyMultiAudio(s); },
    { scope: 'movix', shouldCache: r => r.length > 0 }
  );
}

async function fetchMovixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  extractorConfig?: ExtractorConfig
): Promise<MovixStream[]> {
  console.log(`[Movix] Searching for TMDB ${tmdbId}...`);

  // Fetch all 3 sources in parallel
  const [purstreamResults, cpasmalLinks, fstreamLinks] = await Promise.all([
    fetchPurstream(tmdbId, mediaType, season, episode),
    fetchCpasmal(tmdbId, mediaType, season, episode),
    fetchFStream(tmdbId, mediaType, season, episode),
  ]);

  console.log(`[Movix] Purstream=${purstreamResults.length}, Cpasmal=${cpasmalLinks.length}, FStream=${fstreamLinks.length}`);

  const streams: MovixStream[] = [...purstreamResults];

  // Merge embed links, keep only those our extractor supports.
  const combinedEmbeds = [...cpasmalLinks, ...fstreamLinks];
  const allEmbeds = combinedEmbeds.filter(link => {
    try { return detectExtractor(link.url) !== null; } catch { return false; }
  });

  // Embeds rejetés : signale chaque hôte non reconnu (le bot Telegram grep ça).
  // movix ne résout pas de titre humain ici => title vide.
  for (const link of combinedEmbeds.filter(l => !allEmbeds.includes(l))) {
    let host = link.url;
    try { host = new URL(link.url).hostname; } catch { /* garde l'URL brute */ }
    console.log(`[Movix] Unrecognized host: ${host} (server="${link.server}", title="")`);
  }

  if (allEmbeds.length === 0) {
    console.log(`[Movix] No supported embeds to extract`);
    return streams;
  }

  // Dedupe on server+language BEFORE extraction so parallel calls don't race
  // on the same combo — we'd otherwise waste requests on duplicates.
  const seen = new Set<string>();
  const dedupedEmbeds = allEmbeds.filter(link => {
    const k = `${link.server}-${link.language}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);

  console.log(`[Movix] Extracting ${dedupedEmbeds.length} embed(s) in parallel`);

  const extracted = await Promise.all(
    dedupedEmbeds.map(async link => {
      try {
        const r = await extractStream(link.url, extractorConfig);
        if (r) {
          console.log(`[Movix] Extracted ${link.server} (${link.language}): ${r.format}`);
          return { link, r };
        }
      } catch (e: any) {
        console.log(`[Movix] Failed to extract ${link.server}:`, e.message);
      }
      return null;
    })
  );

  for (const item of extracted) {
    if (!item) continue;
    streams.push({
      name: 'Movix',
      title: `${item.link.language} - ${item.link.server}`,
      url: item.r.url,
      quality: item.r.quality,
      language: item.link.language,
      format: item.r.format === 'hls' ? 'm3u8' : 'mp4',
      headers: item.r.headers,
      server: item.link.server,
    });
  }

  console.log(`[Movix] Total: ${streams.length} stream(s) extracted`);
  return streams;
}

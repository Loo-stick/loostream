import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { isStreamLive } from '../live-check';
import { titlesMatch, normalizeTokens } from '../matching';

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
 * Un master PurStream se présente sous DEUX structures — et le bon traitement diffère :
 *  (A) FILMS — variantes MPEG-TS avec l'audio MUXÉ (h264+aac dans le même .ts) DOUBLÉES
 *      d'un groupe `#EXT-X-MEDIA:TYPE=AUDIO` alterné. Ce master ambigu casse ExoPlayer/
 *      Nuvio (on entend le son, pas d'image). On livre la MEILLEURE VARIANTE, auto-
 *      suffisante -> plus de groupe conflictuel.
 *  (B) SÉRIES/ANIME — variante fMP4 VIDÉO SEULE (init.mp4 = piste `vide` uniquement) ;
 *      l'audio vit dans des renditions SÉPARÉES (audio_0/audio_1). Aplatir sur la variante
 *      = IMAGE SANS SON. Il faut GARDER LE MASTER pour préserver le groupe audio.
 * On distingue en sondant la variante choisie (`variantHasMuxedAudio`). Renvoie {url,
 * quality} — url = variante (cas A) ou master (cas B) — ou null (pas un master / échec).
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
    if (!best) return null;

    // Pas de groupe audio séparé -> aplatir sans risque (rien à préserver).
    const hasSeparateAudio = /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="/i.test(text);
    if (!hasSeparateAudio) return { url: best.url, quality: best.res };

    // Groupe séparé présent : la variante porte-t-elle son propre audio (muxé) ?
    const muxed = await variantHasMuxedAudio(best.url, headers);
    if (muxed) return { url: best.url, quality: best.res }; // FILMS : aplatir (tue l'ambiguïté)
    return { url: masterUrl, quality: best.res };           // ANIME : garder le master (garde le son)
  } catch {
    return null;
  }
}

/**
 * `true` si les segments de la variante contiennent déjà l'audio (muxé). MPEG-TS purstream
 * = muxé (h264+aac). fMP4 : on lit l'init (EXT-X-MAP) — une piste `soun`/`mp4a` = muxé,
 * son absence = vidéo seule (audio en rendition séparée). Repli en cas d'échec : `true`
 * (= comportement historique : on aplatit).
 */
async function variantHasMuxedAudio(
  variantUrl: string,
  headers: Record<string, string>,
): Promise<boolean> {
  try {
    const { data } = await axios.get<string>(variantUrl, {
      headers, timeout: 10000, responseType: 'text', transformResponse: r => r,
    });
    const pl = String(data || '');
    const vbase = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);
    const mapUri = pl.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/i)?.[1];
    if (!mapUri) return true; // TS (ou inconnu) -> muxé côté films purstream
    const initUrl = /^https?:\/\//i.test(mapUri) ? mapUri : new URL(mapUri, vbase).toString();
    const { data: init } = await axios.get(initUrl, {
      headers: { ...headers, Range: 'bytes=0-16383' }, timeout: 10000, responseType: 'arraybuffer',
    });
    const buf = Buffer.from(init as ArrayBuffer);
    return buf.includes(Buffer.from('soun')) || buf.includes(Buffer.from('mp4a'));
  } catch {
    return true;
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
  // Séries : /tv/<id>/season/<s>?episode=<e> (l'ancien /tv/<id>/<s>/<e> renvoyait 404 ->
  // on perdait TOUT fstream en série). Films : /movie/<id> (inchangé).
  const url = mediaType === 'series'
    ? `${endpoints.api}/api/fstream/tv/${tmdbId}/season/${season || 1}?episode=${episode || 1}`
    : `${endpoints.api}/api/fstream/movie/${tmdbId}`;

  console.log(`[Movix] FStream: ${url}`);

  try {
    const { data } = await axios.get(url, { headers: buildHeaders(), timeout: 10000 });

    // Films : data.players.{VFQ,VFF,VOSTFR,Default}. Séries : data.episodes.<ep>.languages.{VF,VOSTFR}.
    const buckets: Record<string, any> = mediaType === 'series'
      ? (data?.episodes?.[String(episode || 1)]?.languages || {})
      : (data?.players || {});

    const bucketToLang: Record<string, string> = { VFQ: 'VF', VFF: 'VF', VF: 'VF', VOSTFR: 'VOSTFR' };
    const links: CpasmalLink[] = [];

    for (const [bucket, lang] of Object.entries(bucketToLang)) {
      const items = buckets[bucket];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item?.url) {
          links.push({ server: (item.player || 'unknown').toLowerCase(), url: item.url, language: lang });
        }
      }
    }
    return links;
  } catch (e: any) {
    console.log('[Movix] FStream failed:', e?.message || e);
    return [];
  }
}

// KissKH (Movix) : drama coréen/chinois/thaï + anime asiatique. Renvoie un m3u8 DIRECT
// (CDN ouvert, aucun header requis) -> comme purstream, pas d'extraction. Endpoint :
// /api/kisskh/tv/<id>?season=&episode= (séries) et /api/kisskh/movie/<id>. Résolution
// async côté Movix : 404/vide = pas dans le catalogue asiatique (normal) ou pas encore résolu.
async function fetchKisskh(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<MovixStream[]> {
  const url = mediaType === 'series'
    ? `${endpoints.api}/api/kisskh/tv/${tmdbId}?season=${season || 1}&episode=${episode || 1}`
    : `${endpoints.api}/api/kisskh/movie/${tmdbId}`;
  console.log(`[Movix] KissKH: ${url}`);
  try {
    const { data } = await axios.get(url, { headers: buildHeaders(), timeout: 12000 });
    if (!Array.isArray(data?.sources)) return [];
    return data.sources
      .filter((s: any) => s?.url && /\.m3u8/i.test(s.url))
      .map((s: any) => ({
        name: 'Movix',
        title: s.label || 'KissKH',
        url: s.url,
        quality: 'HD',
        language: 'VOSTFR', // audio original asiatique + sous-titres (FR via notre ressource /subtitles)
        format: 'm3u8',
        server: 'kisskh',
      }));
  } catch (e: any) {
    return []; // 404 hors catalogue asiatique = normal
  }
}

// SeekStreaming (Movix) : embeds communautaires `https://<origin>/#<videoId>` listés par
// /api/links, résolus via `<origin>/api/v1/video?id=<videoId>` -> réponse HEX chiffrée
// AES-128-CBC (clé/IV en dur, repris de l'extension Movix) -> JSON { source } = master HLS
// MULTI-AUDIO (souvent VF+VO). Master IP+token -> exige Origin/Referer de l'embed.
const SEEK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const SEEK_KEY = Buffer.from('kiemtienmua911ca'); // AES-128
const SEEK_IV = Buffer.from('1234567890oiuytr');

function isSeekEmbed(u: string): boolean {
  return /^https?:\/\/[^/]+\/#[A-Za-z0-9_-]{1,128}$/.test(u);
}

async function resolveSeekEmbed(embedUrl: string): Promise<MovixStream | null> {
  try {
    const u = new URL(embedUrl);
    const origin = u.origin;
    const id = u.hash.slice(1);
    const api = `${origin}/api/v1/video?id=${encodeURIComponent(id)}&w=1920&h=1080&r=`;
    const { data } = await axios.get<string>(api, {
      headers: { 'User-Agent': SEEK_UA, Accept: '*/*', Origin: origin, Referer: `${origin}/` },
      timeout: 10000, responseType: 'text', transformResponse: r => r,
    });
    const dec = crypto.createDecipheriv('aes-128-cbc', SEEK_KEY, SEEK_IV);
    const clear = Buffer.concat([dec.update(Buffer.from(String(data).trim().replace(/"/g, ''), 'hex')), dec.final()]).toString();
    const j = JSON.parse(clear);
    const master: unknown = j.source || j.cfNative || j.master || j.masterUrl;
    if (typeof master !== 'string' || !/^https?:\/\//.test(master)) return null;
    return {
      name: 'Movix', title: 'SeekStreaming', url: master, quality: 'HD',
      language: 'MULTI', format: 'm3u8', server: 'seekstreaming',
      headers: { 'User-Agent': SEEK_UA, Origin: origin, Referer: `${origin}/` },
    };
  } catch { return null; }
}

async function fetchSeekStreaming(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<MovixStream[]> {
  const url = mediaType === 'series'
    ? `${endpoints.api}/api/links/tv/${tmdbId}`
    : `${endpoints.api}/api/links/movie/${tmdbId}`;
  console.log(`[Movix] SeekStreaming: ${url}`);
  try {
    const { data } = await axios.get(url, { headers: buildHeaders(), timeout: 10000 });
    if (!Array.isArray(data?.data)) return [];
    const entries = mediaType === 'series'
      ? data.data.filter((e: any) => Number(e.season_number) === (season || 1) && Number(e.episode_number) === (episode || 1))
      : data.data;
    const embeds: string[] = [...new Set(
      entries.flatMap((e: any) => (Array.isArray(e.links) ? e.links : [])
        .map((l: any) => (typeof l === 'string' ? l : l?.url))
        .filter((u: any): u is string => typeof u === 'string' && isSeekEmbed(u))) as string[]
    )].slice(0, 4); // cap : résolution AES = 1 requête/embed
    const resolved = await Promise.all(embeds.map((e: string) => resolveSeekEmbed(e)));
    return resolved.filter((s): s is MovixStream => s !== null);
  } catch {
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

  // Fetch en parallèle. purstream + kisskh + seekstreaming = m3u8 DIRECTS ; cpasmal + fstream = embeds.
  const [purstreamResults, cpasmalLinks, fstreamLinks, kisskhResults, seekResults] = await Promise.all([
    fetchPurstream(tmdbId, mediaType, season, episode),
    fetchCpasmal(tmdbId, mediaType, season, episode),
    fetchFStream(tmdbId, mediaType, season, episode),
    fetchKisskh(tmdbId, mediaType, season, episode),
    fetchSeekStreaming(tmdbId, mediaType, season, episode),
  ]);

  console.log(`[Movix] Purstream=${purstreamResults.length}, Cpasmal=${cpasmalLinks.length}, FStream=${fstreamLinks.length}, KissKH=${kisskhResults.length}, Seek=${seekResults.length}`);

  const streams: MovixStream[] = [...purstreamResults, ...kisskhResults, ...seekResults];

  // Merge embed links, extract those our extractor supports.
  const embedStreams = await extractMovixEmbeds([...cpasmalLinks, ...fstreamLinks], extractorConfig);
  streams.push(...embedStreams);

  console.log(`[Movix] Total: ${streams.length} stream(s) extracted`);
  return streams;
}

// Résout une liste d'embeds ({url, server, language}) en flux jouables : ne garde que
// les hôtes que nos extracteurs supportent (les autres sont loggués — le bot Telegram
// grep « Unrecognized host »), dédoublonne sur server+langue, extrait ≤8 en parallèle.
// Partagé par les providers embed (cpasmal/fstream) et l'API anime (sibnet/ansembed…).
async function extractMovixEmbeds(
  embeds: { url: string; server?: string; language: string }[],
  extractorConfig?: ExtractorConfig,
): Promise<MovixStream[]> {
  const supported = embeds.filter(link => {
    try { return detectExtractor(link.url) !== null; } catch { return false; }
  });
  for (const link of embeds.filter(l => !supported.includes(l))) {
    let host = link.url;
    try { host = new URL(link.url).hostname; } catch { /* garde l'URL brute */ }
    console.log(`[Movix] Unrecognized host: ${host} (server="${link.server}", title="")`);
  }
  if (supported.length === 0) {
    console.log(`[Movix] No supported embeds to extract`);
    return [];
  }
  // Dedupe on server+language BEFORE extraction so parallel calls don't race
  // on the same combo — we'd otherwise waste requests on duplicates.
  const seen = new Set<string>();
  const deduped = supported.filter(link => {
    const k = `${link.server}-${link.language}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);

  console.log(`[Movix] Extracting ${deduped.length} embed(s) in parallel`);

  const extracted = await Promise.all(
    deduped.map(async link => {
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

  const out: MovixStream[] = [];
  for (const item of extracted) {
    if (!item) continue;
    out.push({
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
  return out;
}

// ---- Movix ANIME (anime-sama via l'API /anime/search de Movix) --------------------
// Movix a déjà fait le gros du travail sur anime-sama : fuzzy-match du titre -> saisons
// NOMMÉES ("Thousand-Year Blood War Partie 4", "Kai", "Film"...) -> épisodes -> players
// (sibnet, ansembed, oneupload, embed4me, sendvid, + mp4 direct anime-sama). On mappe la
// (saison, épisode) Nuvio vers la bonne saison anime-sama par tokens d'arc + numéro de
// partie (les saisons ne sont PAS ordonnées : "Partie 4" arrive après "Kai"), puis on
// livre les embeds extractibles. sibnet + ansembed couvrent VOSTFR+VF sur chaque épisode.
// Résout ce que notre scraper animesama direct rate : les arcs (TYBW) que Nuvio découpe
// en série séparée et qu'anime-sama range sous la franchise avec des chemins non séquentiels.

interface AsEpisode { name?: string; index?: number; streaming_links?: { language: string; players: string[] }[] }
interface AsSeason { name?: string; episodes?: AsEpisode[] }

// Le fuzzy Movix ne matche pas les titres d'arc complets ("Bleach: Thousand-Year..." -> 0
// résultat) : on cherche sur la FRANCHISE (avant un sous-titre).
function animeSearchName(title: string): string {
  return (title.split(/\s*[:–—]\s*|\s+-\s+/)[0] || title).trim();
}

async function searchMovixAnime(titles: string[]): Promise<AsSeason[] | null> {
  const tried = new Set<string>();
  for (const t of titles) {
    const q = animeSearchName(t);
    if (!q || tried.has(q.toLowerCase())) continue;
    tried.add(q.toLowerCase());
    try {
      const { data } = await axios.get(
        `${endpoints.api}/anime/search/${encodeURIComponent(q)}?includeSeasons=true&includeEpisodes=true`,
        { headers: buildHeaders(), timeout: 15000 },
      );
      const list: any[] = Array.isArray(data) ? data : (data?.results || data?.data || []);
      if (!list.length) continue;
      const anime = list.find(a => {
        const cands = [a.name, ...(a.alternative_names || [])].filter(Boolean);
        return cands.some((c: string) => titlesMatch(titles, c));
      }) || list[0];
      if (anime?.seasons?.length) {
        console.log(`[MovixAnime] "${q}" -> "${anime.name}" (${anime.seasons.length} saisons)`);
        return anime.seasons as AsSeason[];
      }
    } catch { /* essaie le titre suivant */ }
  }
  return null;
}

// Choisit la saison anime-sama : score = recouvrement de tokens d'arc (le titre au-delà de
// la franchise) x10 + bonus si le numéro de Partie/Saison == saison demandée. Pénalise les
// hors-série (Film/OAV/Kai) et les mauvais numéros de partie.
function pickAnimeSeason(seasons: AsSeason[], titles: string[], reqSeason: number): AsSeason | null {
  if (!seasons.length) return null;
  const want = new Set(titles.flatMap(t => normalizeTokens(t)));
  let best: AsSeason | null = null, bestScore = -Infinity;
  for (const s of seasons) {
    const name = s.name || '';
    const overlap = normalizeTokens(name).filter(t => want.has(t)).length;
    const m = name.match(/(?:partie|part|saison|season|cour)\s*(\d+)/i);
    const snum = m ? parseInt(m[1], 10) : null;
    let score = overlap * 10;
    if (snum === reqSeason) score += 6;
    else if (snum !== null) score -= 2;
    if (/\b(film|oav|ova|special|kai)\b/i.test(name)) score -= 4;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

function pickAnimeEpisode(season: AsSeason, reqEpisode: number): AsEpisode | null {
  const eps = season.episodes || [];
  if (!eps.length) return null;
  return eps.find(e => e.index === reqEpisode) || eps[reqEpisode - 1] || null;
}

async function fetchMovixAnime(
  titles: string[], season: number, episode: number,
): Promise<{ url: string; server: string; language: string }[]> {
  const seasons = await searchMovixAnime(titles);
  if (!seasons) { console.log(`[MovixAnime] pas de catalogue pour "${titles[0]}"`); return []; }
  const s = pickAnimeSeason(seasons, titles, season);
  if (!s) return [];
  const ep = pickAnimeEpisode(s, episode);
  if (!ep) { console.log(`[MovixAnime] "${s.name}" ép ${episode} introuvable`); return []; }
  console.log(`[MovixAnime] "${titles[0]}" S${season}E${episode} -> "${s.name}" / ${ep.name || 'ep ' + episode}`);
  const out: { url: string; server: string; language: string }[] = [];
  for (const l of ep.streaming_links || []) {
    const lang = /vf/i.test(l.language) ? 'VF' : 'VOSTFR';
    for (const p of l.players || []) {
      // Label = domaine enregistrable (avant-dernier segment) : video.sibnet.ru -> "sibnet",
      // lpayer.embed4me.com -> "embed4me", ansembed.net -> "ansembed".
      let host = 'anime';
      try { const parts = new URL(p).hostname.replace(/^www\./, '').split('.'); host = parts[parts.length - 2] || parts[0]; } catch { /* garde 'anime' */ }
      out.push({ url: p, server: host, language: lang });
    }
  }
  return out;
}

export async function getMovixAnimeStreams(
  titles: string[],
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  extractorConfig?: ExtractorConfig,
): Promise<MovixStream[]> {
  if (mediaType !== 'series' || !season || !episode) return [];
  const uniq = [...new Set(titles.filter(Boolean))];
  if (!uniq.length) return [];
  const mode = extractorConfig?.useMediaFlow ? 'mf' : 'loc';
  const key = `movixanime:${mode}:${uniq[0].toLowerCase()}:${season}:${episode}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    async () => {
      const links = await fetchMovixAnime(uniq, season, episode);
      if (!links.length) return [];
      return applyMultiAudio(await extractMovixEmbeds(links, extractorConfig));
    },
    { scope: 'movix', shouldCache: r => r.length > 0 },
  );
}

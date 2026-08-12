import axios from 'axios';
import * as https from 'https';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { makeEndpointConfig } from '../endpoint-config';

// WaveWatch / ToFlix — agrégateur d'embeds keyé par tmdbId (zéro title-matching).
// Le frontend (tfx05.lol) n'est qu'une vitrine ; le moteur est `apis.wavewatch.top`.
// zeus.php streame les sources en SSE : chaque `event:sources` porte un provider
// (darkst, flux, fuse…) avec ses `sources[]`, et un `event:done` clôt le flux.
// Chaque source est soit un m3u8 DIRECT (finepulfe, multi-audio, iframe:false) soit
// un embed (vidzy/uqload/vidara/fsvid… qu'on résout via nos extracteurs).

const STREAMS_TTL_MS = 15 * 60 * 1000;
const SSE_TIMEOUT_MS = 10_000;
const INSECURE_AGENT = new https.Agent({ rejectUnauthorized: false });

// Base API éditable à chaud (config/wavewatch-endpoints.json, bind-monté + hot-reload)
// ou via l'admin — le domaine `apis.wavewatch.top` peut tourner ; pas de rebuild.
const siteEndpoints = makeEndpointConfig('wavewatch-endpoints.json', 'WAVEWATCH_ENDPOINTS_CONFIG', {
  base: 'https://apis.wavewatch.top',
});
export const reloadWavewatchEndpoints = siteEndpoints.reload;
export const getWavewatchEndpoints = siteEndpoints.get;

// En-têtes SSE : le Referer suit le domaine courant (relu à chaud).
function wwHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': `${siteEndpoints.get().base}/`,
    'Accept': 'text/event-stream',
  };
}

// Le CDN finepulfe (m3u8 direct) a un WAF qui 403 les UA de bibliothèque (curl/python/okhttp
// des players) mais laisse passer un UA navigateur SIMPLE (sans Origin/Referer/sec-ch-ua, qui
// eux re-déclenchent le WAF). C'est ce qui cassait la vidéo : Nuvio (UA player) prenait 403 sur
// les segments vidéo -> audio sans image + durée live. On fetch/proxifie avec cet UA -> OK.
const CDN_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

interface WwSource {
  id?: string; url: string; lang?: string; quality?: string;
  premium?: boolean; iframe?: boolean; format?: string;
}

export interface WavewatchStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  language: string;
  format: string;
  headers?: Record<string, string>;
  server?: string;
  // m3u8 DIRECT (finepulfe) : CDN dont le WAF exige un UA navigateur (les segments 403 sur l'UA
  // du player Nuvio -> audio sans vidéo). On le route par le proxy DU MODE (MediaFlow/local) avec
  // CDN_UA -> notre serveur/MFP fetch avec le bon UA, réécrit le manifeste (multi-audio + subs),
  // Nuvio ne parle qu'à nous. `forceProxy` = jamais en brut/direct (canDirect court-circuité).
  forceProxy?: boolean;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// finepulfe sert un MASTER "démuxé" (audio en groupe #EXT-X-MEDIA séparé) MAIS dont les segments
// vidéo sont en réalité MUXÉS (vidéo + 2 pistes audio dans le même .ts). ExoPlayer (Nuvio) suit
// le master -> joue l'audio séparé et N'AFFICHE PAS la vidéo (conflit démuxé/muxé) ; VLC tolère.
// Fix : résoudre le master vers la playlist VIDÉO (segments self-contained) -> lecture normale,
// multi-audio conservé (2 pistes dans le .ts). Renvoie {url, height}. Fetch avec CDN_UA (WAF).
async function resolveDirectMaster(masterUrl: string): Promise<{ url: string; height: number }> {
  try {
    const { data } = await axios.get(masterUrl, {
      headers: { 'User-Agent': CDN_UA }, timeout: 8000, httpsAgent: INSECURE_AGENT,
    });
    const lines = String(data).split('\n');
    let best: { height: number; url: string } | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const hm = lines[i].match(/RESOLUTION=\d+x(\d+)/i);
      const h = hm ? parseInt(hm[1], 10) : 0;
      const uri = (lines[i + 1] || '').trim();
      if (!uri || uri.startsWith('#')) continue;
      const abs = new URL(uri, masterUrl).toString();
      if (!best || h > best.height) best = { height: h, url: abs };
    }
    return best ? best : { url: masterUrl, height: 0 };
  } catch { return { url: masterUrl, height: 0 }; }
}

function heightToQuality(h: number): string {
  if (h >= 2160) return '4K';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  return 'HD';
}

// Normalise le tag de langue de wavewatch vers nos 4 valeurs canoniques. VFQ = VF (Québec).
// Site FR -> défaut VF quand le tag est vide/inconnu.
function normLang(raw?: string): string {
  const v = (raw || '').toUpperCase().trim();
  if (v === 'MULTI') return 'MULTI';
  if (v === 'VOSTFR') return 'VOSTFR';
  if (v === 'VO') return 'VO';
  if (v.startsWith('VF') || v === 'FRENCH' || v === 'FR') return 'VF';
  return 'VF';
}

function normQuality(raw?: string): string {
  const v = (raw || '').toUpperCase();
  if (v.includes('2160') || v.includes('4K')) return '4K';
  if (v.includes('1080')) return '1080p';
  if (v.includes('720')) return '720p';
  if (v.includes('480')) return '480p';
  return 'HD';
}

/**
 * Lit le flux SSE zeus.php jusqu'à `event:done` (ou timeout/erreur) et renvoie toutes
 * les `sources` aplaties. Traitement ligne par ligne avec buffer (une source peut être
 * scindée entre deux chunks). On ferme la connexion nous-mêmes dès `done`.
 */
async function readZeusSse(url: string): Promise<WwSource[]> {
  const resp = await axios.get(url, {
    headers: wwHeaders(), responseType: 'stream', timeout: SSE_TIMEOUT_MS, httpsAgent: INSECURE_AGENT,
  });
  const stream = resp.data as NodeJS.ReadableStream;
  return await new Promise<WwSource[]>((resolve) => {
    const out: WwSource[] = [];
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { (stream as any).destroy?.(); } catch { /* ignore */ }
      resolve(out);
    };
    const timer = setTimeout(finish, SSE_TIMEOUT_MS);
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const lines = buf.split('\n');
      buf = lines.pop() || ''; // garde la dernière ligne (potentiellement incomplète)
      for (const line of lines) {
        const l = line.trim();
        if (l.startsWith('event:') && l.slice(6).trim() === 'done') { finish(); return; }
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (!payload) continue;
        try {
          const j = JSON.parse(payload);
          if (j && Array.isArray(j.sources)) {
            for (const s of j.sources) if (s && typeof s.url === 'string') out.push(s);
          }
        } catch { /* payload partiel/non-JSON -> ignore */ }
      }
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

// Résout les embeds ({url, server, language}) supportés par nos extracteurs. Dédup sur
// serveur+langue, ≤12 en parallèle. Aligné sur extractMovixEmbeds.
async function extractWwEmbeds(
  embeds: { url: string; server: string; language: string }[],
  extractorConfig?: ExtractorConfig,
): Promise<WavewatchStream[]> {
  const supported = embeds.filter(l => { try { return detectExtractor(l.url) !== null; } catch { return false; } });
  for (const l of embeds.filter(l => !supported.includes(l))) {
    console.log(`[Wavewatch] Unrecognized host: ${l.server} (lang="${l.language}")`);
  }
  if (!supported.length) return [];

  const seen = new Set<string>();
  const deduped = supported.filter(l => {
    const k = `${l.server}-${l.language}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 12);

  console.log(`[Wavewatch] Extracting ${deduped.length} embed(s) in parallel`);
  const extracted = await Promise.all(deduped.map(async l => {
    try {
      const r = await extractStream(l.url, extractorConfig);
      if (r) { console.log(`[Wavewatch] Extracted ${l.server} (${l.language}): ${r.format}`); return { l, r }; }
    } catch (e: any) { console.log(`[Wavewatch] Failed to extract ${l.server}:`, e.message); }
    return null;
  }));

  const out: WavewatchStream[] = [];
  for (const item of extracted) {
    if (!item) continue;
    out.push({
      name: 'WaveWatch',
      title: `${item.l.language} - ${item.l.server}`,
      url: item.r.url,
      quality: item.r.quality,
      language: item.l.language,
      format: item.r.format === 'hls' ? 'm3u8' : 'mp4',
      headers: item.r.headers,
      server: item.l.server,
    });
  }
  return out;
}

async function fetchWavewatchStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  extractorConfig?: ExtractorConfig,
): Promise<WavewatchStream[]> {
  const type = mediaType === 'series' ? 'tv' : 'movie';
  let url = `${siteEndpoints.get().base}/zeus.php?sse&type=${type}&id=${encodeURIComponent(tmdbId)}`;
  if (type === 'tv') url += `&s=${season || 1}&e=${episode || 1}`;

  let sources: WwSource[];
  try { sources = await readZeusSse(url); }
  catch (e: any) { console.log('[Wavewatch] SSE error:', e.message); return []; }

  console.log(`[Wavewatch] ${sources.length} source(s) via zeus SSE (TMDB ${tmdbId})`);
  if (!sources.length) return [];

  const streams: WavewatchStream[] = [];
  const embeds: { url: string; server: string; language: string }[] = [];

  for (const s of sources) {
    const lang = normLang(s.lang);
    const isDirectM3u8 = s.iframe === false || /\.m3u8(\?|$)/i.test(s.url);
    if (isDirectM3u8) {
      // m3u8 direct (finepulfe…) : master démuxé -> résous vers la playlist vidéo (segments muxés)
      // pour que ExoPlayer affiche l'image ; CDN à WAF UA-gaté -> proxifié par le mode avec CDN_UA.
      const v = await resolveDirectMaster(s.url);
      streams.push({
        name: 'WaveWatch', title: `${lang} - direct`, url: v.url,
        quality: v.height ? heightToQuality(v.height) : normQuality(s.quality),
        language: lang, format: 'm3u8',
        server: hostOf(s.url), headers: { 'User-Agent': CDN_UA }, forceProxy: true,
      });
      continue;
    }
    embeds.push({ url: s.url, server: hostOf(s.url), language: lang });
  }

  streams.push(...await extractWwEmbeds(embeds, extractorConfig));
  console.log(`[Wavewatch] Total: ${streams.length} stream(s)`);
  return streams;
}

export async function getWavewatchStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  extractorConfig?: ExtractorConfig,
): Promise<WavewatchStream[]> {
  if (!tmdbId) return [];
  const mode = extractorConfig?.useMediaFlow ? 'mf' : 'loc';
  const key = `wavewatch:${mode}:${mediaType}:${tmdbId}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    async () => {
      const all = await fetchWavewatchStreams(tmdbId, mediaType, season, episode, extractorConfig);
      // applyMultiAudio sonde chaque master -> vraie résolution (fixe le « HD ») + relabel MULTI.
      // On EXCLUT les flux `forceProxy` (finepulfe) : ce sont désormais des media playlists vidéo
      // (segments muxés, pas de RESOLUTION ni #EXT-X-MEDIA à sonder) -> qualité/langue déjà fixées
      // dans le scraper. Les sonder ne sert à rien et risquerait un mauvais relabel.
      const proxied = all.filter(s => s.forceProxy);
      const probe = all.filter(s => !s.forceProxy);
      return [...proxied, ...await applyMultiAudio(probe)];
    },
    { scope: 'wavewatch', shouldCache: r => r.length > 0 },
  );
}

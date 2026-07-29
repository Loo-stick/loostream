import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { extractStream, detectExtractor, ExtractorConfig, ExtractorId } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';

// Wiflix (alias « cinestream ») — source VF/VOSTFR exposée par l'API Movix,
// keyée par tmdbId. Endpoint découvert dans l'APK Onyx (WiflixProvider) :
//   GET {movixApi}/api/wiflix/movie/{tmdbId}
//   GET {movixApi}/api/wiflix/tv/{tmdbId}/{season}
// Réponse : { success, source, players: { vf: [...], vostfr: [...] } } où chaque
// entrée est { name, url, episode, type }. `name` = hôte (luluvdo.com, …).
//
// Aucun scraping : pas de domaine à résoudre, pas de recherche, pas de
// correspondance de titre — d'où une source très peu fragile. Les en-têtes
// Movix (Referer/Origin) sont obligatoires, sinon l'API renvoie une erreur.

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 12000;
const MAX_EXTRACTIONS = 8;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

const MOVIX_ENDPOINTS_PATH = process.env.MOVIX_ENDPOINTS_CONFIG ||
  (fs.existsSync('/app/config/movix-endpoints.json')
    ? '/app/config/movix-endpoints.json'
    : path.join(process.cwd(), 'config', 'movix-endpoints.json'));

function movixApiConfig(): { api: string; referer: string; origin: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(MOVIX_ENDPOINTS_PATH, 'utf-8'));
    return {
      api: (raw.api || 'https://api.movix.show').replace(/\/+$/, ''),
      referer: raw.referer || 'https://movix.cash/',
      origin: raw.origin || 'https://movix.cash',
    };
  } catch {
    return { api: 'https://api.movix.show', referer: 'https://movix.cash/', origin: 'https://movix.cash' };
  }
}

export interface WiflixStream {
  url: string;
  quality: string;
  language: string;   // 'VF' | 'VOSTFR' | 'VO'
  server: string;     // hôte d'origine (luluvdo, filelions, …)
  headers?: Record<string, string>;
}

function normalizeLang(k: string): string {
  const u = (k || '').toUpperCase();
  if (u.includes('VOST')) return 'VOSTFR';
  if (u === 'VO' || u.includes('ORIGINAL')) return 'VO';
  return 'VF';
}

/** Nom de serveur lisible depuis l'hôte (luluvdo.com -> luluvdo). */
function serverName(url: string, fallback: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h.split('.')[0] || fallback;
  } catch {
    return fallback || 'wiflix';
  }
}

interface WiflixEmbed { url: string; language: string; server: string; }

async function fetchEmbeds(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<WiflixEmbed[]> {
  const { api, referer, origin } = movixApiConfig();
  const url = mediaType === 'series'
    ? `${api}/api/wiflix/tv/${tmdbId}/${season}`
    : `${api}/api/wiflix/movie/${tmdbId}`;
  try {
    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Referer: referer, Origin: origin },
      timeout: REQ_TIMEOUT_MS,
    });
    if (!data?.success) return [];

    // Films : players{vf|vostfr:[…]}. Séries : episodes{"N":{vf|vostfr:[…]}}.
    const byLang: Record<string, any[]> | undefined = mediaType === 'series'
      ? data?.episodes?.[String(episode)]
      : data?.players;
    if (!byLang || typeof byLang !== 'object') return [];

    const out: WiflixEmbed[] = [];
    const seen = new Set<string>();
    for (const [lang, list] of Object.entries(byLang)) {
      if (!Array.isArray(list)) continue;
      for (const p of list) {
        if (!p?.url || typeof p.url !== 'string' || seen.has(p.url)) continue;
        // Séries : l'API renvoie tous les épisodes de la saison -> filtrer.
        if (mediaType === 'series' && episode && p.episode && Number(p.episode) !== episode) continue;
        seen.add(p.url);
        out.push({
          url: p.url,
          language: normalizeLang(String(p.type || lang)),
          server: serverName(p.url, String(p.name || 'wiflix')),
        });
      }
    }
    return out;
  } catch (e: any) {
    console.log(`[Wiflix] API failed: ${(e.message || '').slice(0, 90)}`);
    return [];
  }
}

export async function getWiflixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season?: number,
  episode?: number
): Promise<WiflixStream[]> {
  if (!tmdbId) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = mediaType === 'series'
    ? `wiflix:${mode}:series:${tmdbId}:${season}:${episode}`
    : `wiflix:${mode}:movie:${tmdbId}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    async () => { const s = await fetchWiflixStreams(tmdbId, mediaType, extractorConfig, season, episode); return applyMultiAudio(s); },
    { scope: 'wiflix', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchWiflixStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season?: number,
  episode?: number
): Promise<WiflixStream[]> {
  const embeds = await fetchEmbeds(tmdbId, mediaType, season, episode);
  if (embeds.length === 0) {
    console.log(`[Wiflix] Aucun lecteur pour TMDB ${tmdbId}`);
    return [];
  }

  // Ne garder que les hôtes qu'on sait extraire.
  const supported = embeds.filter(e => {
    try { return detectExtractor(e.url) !== null; } catch { return false; }
  });
  const unknown = embeds.filter(e => !supported.includes(e));
  if (unknown.length) {
    const hosts = [...new Set(unknown.map(e => e.server))].join(', ');
    console.log(`[Wiflix] ${embeds.length} lecteur(s), ${supported.length} supporté(s) — ignorés: ${hosts}`);
  }
  if (supported.length === 0) return [];

  // Un seul lecteur par (serveur+langue), puis extraction en parallèle.
  const seen = new Set<string>();
  const deduped = supported.filter(e => {
    const k = `${e.server}:${e.language}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_EXTRACTIONS);

  const extracted = await Promise.all(deduped.map(async e => {
    try {
      const r = await extractStream(e.url, extractorConfig);
      if (!r?.url) return null;
      console.log(`[Wiflix] Extracted ${e.server}: ${r.format}`);
      return { e, r };
    } catch {
      return null;
    }
  }));

  const streams: WiflixStream[] = [];
  for (const item of extracted) {
    if (!item) continue;
    streams.push({
      url: item.r.url,
      quality: item.r.quality || 'HD',
      language: item.e.language,
      server: item.e.server,
      headers: item.r.headers,
    });
  }
  console.log(`[Wiflix] Returning ${streams.length} stream(s)`);
  return streams;
}

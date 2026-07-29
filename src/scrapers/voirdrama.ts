import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { makeEndpointConfig } from '../endpoint-config';

// VoirDrama — dramas asiatiques (K-drama, J-drama, C-drama), exposé par l'API
// Movix et keyé par tmdbId. Endpoint découvert en sondant l'API : contrairement
// aux autres, il ne suit pas la forme /api/x/tv/{id}/{season} — il attend la
// saison et l'épisode en query string :
//   GET {movixApi}/api/drama/tv/{tmdbId}?season={S}&episode={E}
// Réponse : { success, data: [{ name, link }], tmdbId, season, episode }
//
// L'API le dit elle-même si on se trompe de forme :
//   "Ce point de terminaison ne supporte que type=tv pour le moment avec
//    saison/episode"
// → pas de films, uniquement des séries. On sort tôt pour les films.
//
// Le provider Onyx (VoirDramaProvider dans classes3.dex) scrape voirdrama.to
// par titre avec un repli sur Dramacool. On préfère l'API : keyée par tmdbId,
// donc aucune correspondance de titre à faire — bien moins fragile.

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 12000;
const MAX_EXTRACTIONS = 6;

// L'API ne renvoie aucun champ de langue. Le catalogue voirdrama.to compte 5296
// fiches : 4994 sans suffixe et 302 en "-vf". Le défaut du site est donc le
// sous-titré français — et il n'y a ni VO ni MULTI nulle part.
const DRAMA_LANGUAGE = 'VOSTFR';

// --- Scraping (complément de l'API) -----------------------------------------
// L'API ne sert que des séries et rate une partie du catalogue (alice-in-borderland
// est absent de l'API mais bien présent sur le site, en VF). Le scraping couvre
// donc deux angles morts : les films, et la VF.
//
// Structure du site (WordPress, thème Madara) :
//   recherche : /?s={titre}&post_type=wp-manga
//   fiche     : /drama/{slug}/            ← "-vf" en suffixe = doublé, sinon VOSTFR
//   lecture   : /drama/{slug}/{chapitre}/ ← contient les lecteurs
//
// Les lecteurs sont dans un blob JSON de la page de lecture, sous des clés
// contenant "LECTEUR" :
//   "☰ LECTEUR 4 VOE":"<iframe src=\"https://voe.sx/e/xxxx\" ...>"
// Le motif ci-dessous vient du provider Onyx (fetchVoirDramaNative).
// Base du site éditable dans config/voirdrama-endpoints.json (hot-reload).
const siteEndpoints = makeEndpointConfig('voirdrama-endpoints.json', 'VOIRDRAMA_ENDPOINTS_CONFIG', {
  base: 'https://voirdrama.to',
});
export const reloadVoirDramaEndpoints = siteEndpoints.reload;
export const getVoirDramaEndpoints = siteEndpoints.get;
const SITE_BASE = () => siteEndpoints.get().base;
const SCRAPE_TIMEOUT_MS = 15000;
const MAX_VARIANTS = 2; // au plus une fiche VF + une fiche VOSTFR

const PLAYER_RX = /"([^"]*LECTEUR[^"]*)"\s*:\s*"(?:[^"\\]|\\.)*?src=\\?["']?(https?:(?:[^"'\\\s]|\\\/)+)/g;
// Host-agnostic (matchent /drama/ sur n'importe quel domaine) pour rester
// valides si la base est changée dans config/voirdrama-endpoints.json.
const SEARCH_ITEM_RX = /<h3[^>]*>\s*<a\s+href="(https?:\/\/[a-z0-9.-]+\/drama\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
const CHAPTER_RX = /<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]{0,300}?<a\s+href="(https?:\/\/[a-z0-9.-]+\/drama\/[^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

async function getHtml(url: string): Promise<string | null> {
  try {
    const { data, status } = await axios.get<string>(url, {
      headers: BROWSER_HEADERS,
      timeout: SCRAPE_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: v => v,
      validateStatus: () => true,
      maxRedirects: 4,
      decompress: true,
    });
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

/** "Old Boy (VF)" / "Oldboy: le film" -> "oldboy" — pour comparer des titres. */
function normalizeTitle(t: string): string {
  return t
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\((?:vf|vostfr|vost|vo|multi)\)/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** Le suffixe "-vf" du slug (et le "(VF)" du titre) portent la langue. */
function languageOf(url: string, title: string): string {
  const slug = url.replace(/\/+$/, '').split('/').pop() || '';
  if (/-vf$/.test(slug) || /\(\s*vf\s*\)/i.test(title)) return 'VF';
  return 'VOSTFR';
}

interface Candidate { url: string; title: string; language: string; }

/** Saison portée par une fiche ("…-saison-2"), 1 par défaut. */
function seasonOf(url: string, title: string): number {
  const m = `${url} ${title}`.match(/sais?on[\s-]*0*(\d+)/i) || `${url} ${title}`.match(/season[\s-]*0*(\d+)/i);
  return m ? Number(m[1]) : 1;
}

async function searchSite(title: string, season?: number): Promise<Candidate[]> {
  const html = await getHtml(`${SITE_BASE()}/?s=${encodeURIComponent(title)}&post_type=wp-manga`);
  if (!html) return [];
  const target = normalizeTitle(title);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(SEARCH_ITEM_RX)) {
    const url = m[1];
    const name = m[2].trim();
    if (seen.has(url)) continue;
    seen.add(url);
    const norm = normalizeTitle(name);
    // Correspondance stricte ou par inclusion : les fiches ajoutent souvent un
    // sous-titre ("Oldboy" vs "Oldboy: The Original"), mais on refuse le vague.
    if (!norm || (norm !== target && !norm.startsWith(target) && !target.startsWith(norm))) continue;
    // Chaque saison est une fiche distincte sur le site. Servir l'épisode 3 de la
    // saison 1 à quelqu'un qui demande la saison 2 est pire que ne rien servir.
    if (season && seasonOf(url, name) !== season) continue;
    out.push({ url, title: name, language: languageOf(url, name) });
  }
  // Une seule fiche par langue, en gardant la correspondance la plus proche.
  const byLang = new Map<string, Candidate>();
  for (const c of out.sort((a, b) => normalizeTitle(a.title).length - normalizeTitle(b.title).length)) {
    if (!byLang.has(c.language)) byLang.set(c.language, c);
  }
  return [...byLang.values()].slice(0, MAX_VARIANTS);
}

/**
 * Trouve la page de lecture d'une fiche. Pour un film il n'y a qu'un "chapitre" ;
 * pour une série on cherche celui qui porte le bon numéro d'épisode.
 */
async function findReadingPage(dramaUrl: string, episode?: number): Promise<string | null> {
  const html = await getHtml(dramaUrl);
  if (!html) return null;
  const chapters: { url: string; label: string }[] = [];
  for (const m of html.matchAll(CHAPTER_RX)) {
    chapters.push({ url: m[1], label: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  if (chapters.length === 0) return null;
  if (!episode) return chapters[0].url; // film : un seul chapitre

  for (const c of chapters) {
    if (episodeNumberOf(c.label, c.url) === episode) return c.url;
  }
  return null;
}

/**
 * Numéro d'épisode d'un chapitre. Le site n'écrit pas toujours "épisode" :
 *   libellé "Alice in Borderland - 08 VF - 08", slug "alice-in-borderland-08-vf"
 * On tente donc, dans l'ordre : le mot-clé explicite, puis le nombre en fin de
 * slug (en tolérant le suffixe de langue), puis le nombre en fin de libellé.
 */
function episodeNumberOf(label: string, url: string): number | null {
  const slug = url.replace(/\/+$/, '').split('/').pop() || '';

  const kw = label.match(/(?:épisode|episode|ep)\s*0*(\d+)/i) || slug.match(/-(?:episode|ep)-0*(\d+)/i);
  if (kw) return Number(kw[1]);

  // "…-08-vf" / "…-08" — mais pas "…-2005-film-vf", d'où la limite à 3 chiffres.
  const fromSlug = slug.match(/-0*(\d{1,3})(?:-(?:vf|vostfr|vost|vo|multi))?$/i);
  if (fromSlug) return Number(fromSlug[1]);

  const fromLabel = label.match(/(?:^|[\s-])0*(\d{1,3})\s*$/);
  if (fromLabel) return Number(fromLabel[1]);

  return null;
}

/** Extrait les URLs d'embed d'une page de lecture. */
async function playersFrom(readingUrl: string): Promise<DramaEmbed[]> {
  const html = await getHtml(readingUrl);
  if (!html) return [];
  const out: DramaEmbed[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(PLAYER_RX)) {
    const url = m[2].replace(/\\\//g, '/');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, server: serverName(url, 'voirdrama') });
  }
  return out;
}

/** Cherche le titre sur le site et renvoie les embeds par langue. */
async function scrapeEmbeds(
  title: string,
  season?: number,
  episode?: number
): Promise<{ embeds: DramaEmbed[]; language: string }[]> {
  const candidates = await searchSite(title, season);
  if (candidates.length === 0) {
    console.log(`[VoirDrama] Scraping: aucune fiche pour "${title}"`);
    return [];
  }
  const found = await Promise.all(candidates.map(async c => {
    const reading = await findReadingPage(c.url, episode);
    if (!reading) return null;
    const embeds = await playersFrom(reading);
    if (embeds.length === 0) return null;
    console.log(`[VoirDrama] Scraping ${c.language}: ${embeds.length} lecteur(s) — ${c.title}`);
    return { embeds, language: c.language };
  }));
  return found.filter((x): x is { embeds: DramaEmbed[]; language: string } => x !== null);
}

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

export interface VoirDramaStream {
  url: string;
  quality: string;
  language: string;
  server: string;
  headers?: Record<string, string>;
}

/** Nom de serveur lisible depuis l'hôte (vidmoly.biz -> vidmoly). */
function serverName(url: string, fallback: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    // "my.mail.ru" -> "my" serait illisible ; on garde le nom de la plateforme.
    if (/(^|\.)mail\.ru$/.test(h)) return 'mailru';
    if (/(^|\.)ok\.ru$/.test(h) || h.includes('odnoklassniki')) return 'okru';
    return h.split('.')[0] || fallback;
  } catch {
    return (fallback || 'voirdrama').toLowerCase();
  }
}

interface DramaEmbed { url: string; server: string; }

// `definitive` = l'API a répondu de façon autoritaire (trouvé, ou 404 "pas un
// drama") -> inutile de retomber sur le scraping. false = vraie panne (réseau /
// 5xx) -> le scraping en repli a du sens.
async function fetchEmbeds(tmdbId: string, season: number, episode: number): Promise<{ embeds: DramaEmbed[]; definitive: boolean }> {
  const { api, referer, origin } = movixApiConfig();
  const url = `${api}/api/drama/tv/${tmdbId}?season=${season}&episode=${episode}`;
  try {
    const { data, status } = await axios.get(url, {
      headers: { ...HEADERS, Referer: referer, Origin: origin },
      timeout: REQ_TIMEOUT_MS,
      validateStatus: () => true,
    });
    // 404 / success:false = pas trouvé (souvent : pas un drama). Réponse claire,
    // pas une panne : on ne scrape pas derrière.
    if (status === 404 || data?.success === false) {
      console.log(`[VoirDrama] Pas de drama pour TMDB ${tmdbId} (API: pas trouvé)`);
      return { embeds: [], definitive: true };
    }
    if (status < 200 || status >= 300 || !data?.success || !Array.isArray(data.data)) {
      console.log(`[VoirDrama] Réponse API inattendue (HTTP ${status})`);
      return { embeds: [], definitive: false };
    }

    const out: DramaEmbed[] = [];
    const seen = new Set<string>();
    for (const p of data.data) {
      const link = p?.link;
      if (!link || typeof link !== 'string' || !/^https?:\/\//.test(link)) continue;
      if (seen.has(link)) continue;
      seen.add(link);
      out.push({ url: link, server: serverName(link, String(p.name || 'voirdrama')) });
    }
    return { embeds: out, definitive: true };
  } catch (e: any) {
    console.log(`[VoirDrama] Erreur réseau API: ${(e.message || '').slice(0, 90)}`);
    return { embeds: [], definitive: false };
  }
}

export async function getVoirDramaStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season?: number,
  episode?: number,
  title?: string
): Promise<VoirDramaStream[]> {
  if (mediaType === 'series' && (!tmdbId || !season || !episode)) return [];
  if (mediaType === 'movie' && !title) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = mediaType === 'series'
    ? `voirdrama:${mode}:series:${tmdbId}:${season}:${episode}`
    : `voirdrama:${mode}:movie:${tmdbId || normalizeTitle(title || '')}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    async () => { const s = await fetchVoirDramaStreams(tmdbId, mediaType, extractorConfig, season, episode, title); return applyMultiAudio(s); },
    { scope: 'voirdrama', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

/** Extraction commune : filtre aux hôtes gérés, dédoublonne, extrait en parallèle. */
async function extractAll(
  embeds: DramaEmbed[],
  language: string,
  extractorConfig: ExtractorConfig
): Promise<VoirDramaStream[]> {
  // Ok.ru / my.mail.ru revient systématiquement et n'a pas d'extracteur —
  // c'est le rejet attendu.
  const supported = embeds.filter(e => {
    try { return detectExtractor(e.url) !== null; } catch { return false; }
  });
  const unknown = embeds.filter(e => !supported.includes(e));
  if (unknown.length) {
    const hosts = [...new Set(unknown.map(e => e.server))].join(', ');
    console.log(`[VoirDrama] ${embeds.length} lecteur(s), ${supported.length} supporté(s) — ignorés: ${hosts}`);
  }
  if (supported.length === 0) return [];

  const seen = new Set<string>();
  const deduped = supported.filter(e => {
    if (seen.has(e.server)) return false;
    seen.add(e.server);
    return true;
  }).slice(0, MAX_EXTRACTIONS);

  const extracted = await Promise.all(deduped.map(async e => {
    try {
      const r = await extractStream(e.url, extractorConfig);
      if (!r?.url) return null;
      console.log(`[VoirDrama] Extracted ${e.server} (${language}): ${r.format}`);
      return { e, r };
    } catch {
      return null;
    }
  }));

  const streams: VoirDramaStream[] = [];
  for (const item of extracted) {
    if (!item) continue;
    streams.push({
      url: item.r.url,
      quality: item.r.quality || 'HD',
      language,
      server: item.e.server,
      headers: item.r.headers,
    });
  }
  return streams;
}

async function fetchVoirDramaStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season?: number,
  episode?: number,
  title?: string
): Promise<VoirDramaStream[]> {
  // Séries : l'API d'abord — keyée par tmdbId, une seule requête, aucun risque de
  // mauvaise correspondance de titre. On ne scrape qu'en cas de trou (l'API rate
  // une partie du catalogue) ou pour un film, qu'elle refuse de servir.
  if (mediaType === 'series') {
    const { embeds, definitive } = await fetchEmbeds(tmdbId, season!, episode!);
    if (embeds.length > 0) {
      const streams = await extractAll(embeds, DRAMA_LANGUAGE, extractorConfig);
      if (streams.length > 0) {
        console.log(`[VoirDrama] Returning ${streams.length} stream(s) (API)`);
        return streams;
      }
    }
    // 404 "pas trouvé" = définitif -> on n'appelle pas le scraping (temps perdu).
    // Le repli scraping ne sert qu'en cas de vraie panne API.
    if (definitive) return [];
    console.log(`[VoirDrama] API indispo pour TMDB ${tmdbId} S${season}E${episode}, repli sur le scraping`);
  }

  if (!title) return [];
  const groups = await scrapeEmbeds(
    title,
    mediaType === 'series' ? season : undefined,
    mediaType === 'series' ? episode : undefined
  );
  const perGroup = await Promise.all(
    groups.map(g => extractAll(g.embeds, g.language, extractorConfig))
  );
  const streams = perGroup.flat();
  console.log(`[VoirDrama] Returning ${streams.length} stream(s) (scraping)`);
  return streams;
}

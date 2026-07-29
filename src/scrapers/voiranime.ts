import axios from 'axios';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { makeEndpointConfig } from '../endpoint-config';

// VoirAnime — anime VOSTFR/VF (voir-anime.to). Provider Onyx VoirAnimeProvider.
// Site WordPress/Madara, structure identique à VoirDrama :
//   recherche : /?s={titre}&post_type=wp-manga
//   fiche     : /anime/{slug}/                 ← "-vf" = doublé, sinon VOSTFR
//   lecture   : /anime/{slug}/{slug}-{N}-vostfr/ ← blob JSON de lecteurs "LECTEUR"
// Hôtes servis : vidmoly (extractible), my.mail.ru (extractible), voe…
//
// Scraping pur (pas d'API Movix pour l'anime). Keyé par titre : on résout
// l'id Stremio (tt/tmdb) → titre via TMDB, puis recherche + numéro d'épisode.
// Numérotation ABSOLUE (One Piece 1171) — jusqu'à 4 chiffres.

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const SCRAPE_TIMEOUT_MS = 15000;
const MAX_EXTRACTIONS = 6;
const MAX_VARIANTS = 2; // au plus une fiche VF + une VOSTFR

const siteEndpoints = makeEndpointConfig('voiranime-endpoints.json', 'VOIRANIME_ENDPOINTS_CONFIG', {
  base: 'https://voir-anime.to',
});
export const reloadVoirAnimeEndpoints = siteEndpoints.reload;
export const getVoirAnimeEndpoints = siteEndpoints.get;
const SITE_BASE = () => siteEndpoints.get().base;

const PLAYER_RX = /"([^"]*LECTEUR[^"]*)"\s*:\s*"(?:[^"\\]|\\.)*?src=\\?["']?(https?:(?:[^"'\\\s]|\\\/)+)/g;
const SEARCH_ITEM_RX = /<h3[^>]*>\s*<a\s+href="(https?:\/\/[a-z0-9.-]+\/anime\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
const CHAPTER_RX = /<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]{0,300}?<a\s+href="(https?:\/\/[a-z0-9.-]+\/anime\/[^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

export interface VoirAnimeStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR
  server: string;
  headers?: Record<string, string>;
}

async function getHtml(url: string): Promise<string | null> {
  try {
    const { data, status } = await axios.get<string>(url, {
      headers: BROWSER_HEADERS, timeout: SCRAPE_TIMEOUT_MS,
      responseType: 'text', transformResponse: v => v,
      validateStatus: () => true, maxRedirects: 4, decompress: true,
    });
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

/** "Naruto Shippuden (VF)" -> "narutoshippuden" — pour comparer des titres. */
function normalizeTitle(t: string): string {
  return t
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\((?:vf|vostfr|vost|vo|multi)\)/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function languageOf(url: string, title: string): string {
  const slug = url.replace(/\/+$/, '').split('/').pop() || '';
  if (/-vf$/.test(slug) || /\(\s*vf\s*\)/i.test(title)) return 'VF';
  return 'VOSTFR';
}

function serverName(url: string, fallback: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/(^|\.)mail\.ru$/.test(h)) return 'mailru';
    if (/(^|\.)ok\.ru$/.test(h) || h.includes('odnoklassniki')) return 'okru';
    return h.split('.')[0] || fallback;
  } catch {
    return (fallback || 'voiranime').toLowerCase();
  }
}

interface AnimeEmbed { url: string; server: string; }
interface Candidate { url: string; title: string; language: string; }

/** "One Piece" -> "one-piece" (slug d'URL). */
function slugify(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Bases de slug à essayer, en ordre de priorité. voir-anime DÉCOUPE par saison
 * (S1 = /anime/{slug}/, S2 = /anime/{slug}-2/, numérotation PAR SAISON) et héberge
 * souvent l'anime sous son titre ROMAJI (jigokuraku) plutôt que le titre affiché
 * (hell-s-paradise, souvent un placeholder). On essaie donc le romaji ET l'affiché.
 */
function slugBasesFor(titles: string[], season?: number): string[] {
  const out: string[] = [];
  for (const t of titles) {
    const s = slugify(t);
    if (!s) continue;
    if (!season || season <= 1) out.push(s);
    else out.push(`${s}-${season}`, `${s}-saison-${season}`, `${s}-season-${season}`);
  }
  return [...new Set(out)];
}

async function searchSite(title: string): Promise<Candidate[]> {
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
    if (!norm || (norm !== target && !norm.startsWith(target) && !target.startsWith(norm))) continue;
    out.push({ url, title: name, language: languageOf(url, name) });
  }
  // Une fiche par langue, la correspondance la plus proche d'abord.
  const byLang = new Map<string, Candidate>();
  for (const c of out.sort((a, b) => normalizeTitle(a.title).length - normalizeTitle(b.title).length)) {
    if (!byLang.has(c.language)) byLang.set(c.language, c);
  }
  return [...byLang.values()].slice(0, MAX_VARIANTS);
}

/**
 * Numéro d'épisode d'un chapitre. Anime = numérotation absolue jusqu'à 4
 * chiffres (One Piece 1171). Slug type "one-piece-1171-vostfr".
 */
function episodeNumberOf(label: string, url: string): number | null {
  const slug = url.replace(/\/+$/, '').split('/').pop() || '';
  const kw = label.match(/(?:épisode|episode|ep)\s*0*(\d+)/i) || slug.match(/-(?:episode|ep)-0*(\d+)/i);
  if (kw) return Number(kw[1]);
  const fromSlug = slug.match(/-0*(\d{1,4})(?:-(?:vf|vostfr|vost|vo|multi))?$/i);
  if (fromSlug) return Number(fromSlug[1]);
  const fromLabel = label.match(/(?:^|[\s-])0*(\d{1,4})\s*$/);
  if (fromLabel) return Number(fromLabel[1]);
  return null;
}

/** URL de lecture du bon épisode depuis le HTML d'une fiche (films = 1 seul). */
function episodePageFromHtml(html: string, episode?: number): string | null {
  const chapters: { url: string; label: string }[] = [];
  for (const m of html.matchAll(CHAPTER_RX)) {
    chapters.push({ url: m[1], label: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  if (chapters.length === 0) return null;
  if (!episode) return chapters[0].url; // film / OAV : un seul chapitre
  for (const c of chapters) {
    if (episodeNumberOf(c.label, c.url) === episode) return c.url;
  }
  return null;
}

async function playersFrom(readingUrl: string): Promise<AnimeEmbed[]> {
  const html = await getHtml(readingUrl);
  if (!html) return [];
  const out: AnimeEmbed[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(PLAYER_RX)) {
    const url = m[2].replace(/\\\//g, '/');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, server: serverName(url, 'voiranime') });
  }
  return out;
}

/** Filtre aux hôtes gérés, dédoublonne, extrait en parallèle. */
async function extractAll(
  embeds: AnimeEmbed[], language: string, extractorConfig: ExtractorConfig
): Promise<VoirAnimeStream[]> {
  const supported = embeds.filter(e => {
    try { return detectExtractor(e.url) !== null; } catch { return false; }
  });
  const unknown = embeds.filter(e => !supported.includes(e));
  if (unknown.length) {
    const hosts = [...new Set(unknown.map(e => e.server))].join(', ');
    console.log(`[VoirAnime] ${embeds.length} lecteur(s), ${supported.length} supporté(s) — ignorés: ${hosts}`);
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
      console.log(`[VoirAnime] Extracted ${e.server} (${language}): ${r.format}`);
      return { e, r };
    } catch {
      return null;
    }
  }));

  const streams: VoirAnimeStream[] = [];
  for (const item of extracted) {
    if (!item) continue;
    streams.push({
      url: item.r.url, quality: item.r.quality || 'HD',
      language, server: item.e.server, headers: item.r.headers,
    });
  }
  return streams;
}

export async function getVoirAnimeStreams(
  id: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season: number | undefined,
  episode: number | undefined,
  title: string,
  originalTitle?: string
): Promise<VoirAnimeStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && !episode) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = mediaType === 'series'
    ? `voiranime:${mode}:series:${id}:${season || 1}:${episode}`
    : `voiranime:${mode}:movie:${id || normalizeTitle(title)}`;
  // Titre original (romaji) en priorité, puis affiché.
  const titles = [...new Set([originalTitle, title].filter(Boolean) as string[])];
  return cached(
    key, STREAMS_TTL_MS,
    async () => { const s = await fetchVoirAnimeStreams(mediaType, titles, season, episode, extractorConfig); return applyMultiAudio(s); },
    { scope: 'voiranime', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchVoirAnimeStreams(
  mediaType: 'movie' | 'series', titles: string[], season: number | undefined, episode: number | undefined, extractorConfig: ExtractorConfig
): Promise<VoirAnimeStream[]> {
  const ep = mediaType === 'series' ? episode : undefined;
  const bases = slugBasesFor(titles, mediaType === 'series' ? season : undefined);

  // On essaie chaque base de slug ; on ne retient QUE la première qui contient
  // réellement l'épisode demandé (évite les fiches placeholder à 3 épisodes).
  for (const base of bases) {
    const fiches: { lang: string; reading: string }[] = [];
    for (const [suffix, lang] of [['', 'VOSTFR'], ['-vf', 'VF']] as const) {
      const html = await getHtml(`${SITE_BASE()}/anime/${base}${suffix}/`);
      if (!html || !/wp-manga-chapter/.test(html)) continue;
      const reading = episodePageFromHtml(html, ep);
      if (reading) fiches.push({ lang, reading });
    }
    if (fiches.length === 0) continue; // ce slug n'a pas l'épisode → suivant

    const groups = await Promise.all(fiches.map(async f => {
      const embeds = await playersFrom(f.reading);
      if (embeds.length === 0) return [] as VoirAnimeStream[];
      console.log(`[VoirAnime] ${f.lang} (${base}): ${embeds.length} lecteur(s)`);
      return extractAll(embeds, f.lang, extractorConfig);
    }));
    const streams = groups.flat();
    if (streams.length) {
      console.log(`[VoirAnime] Returning ${streams.length} stream(s) [${base}]`);
      return streams;
    }
  }

  // Repli recherche (S1 uniquement — pas de ciblage de saison fiable).
  if (!season || season <= 1) {
    for (const t of titles) {
      const cands = await searchSite(t);
      const groups = await Promise.all(cands.map(async c => {
        const html = await getHtml(c.url);
        const reading = html ? episodePageFromHtml(html, ep) : null;
        if (!reading) return [] as VoirAnimeStream[];
        const embeds = await playersFrom(reading);
        return extractAll(embeds, c.language, extractorConfig);
      }));
      const streams = groups.flat();
      if (streams.length) { console.log(`[VoirAnime] Returning ${streams.length} stream(s) [search:${t}]`); return streams; }
    }
  }
  console.log(`[VoirAnime] Aucun stream pour "${titles[0]}"`);
  return [];
}

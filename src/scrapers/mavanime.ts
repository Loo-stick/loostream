import axios from 'axios';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { makeEndpointConfig } from '../endpoint-config';
import { makeDnsSafeAgent } from '../dns-resolve';
import { titlesMatch, expandTitles } from '../matching';

// Mavanime (mavanime.top) — anime VOSTFR (peu de VF), simulcast très à jour.
// WordPress/Madara, thème `madara-child-voiranime` : MÊME structure que VoirAnime
//   recherche : /?s={titre}&post_type=wp-manga
//   fiche     : /anime/{slug}/                    ("-vf" = doublé, sinon VOSTFR)
//   lecture   : /anime/{slug}/{slug}-{N}-vostfr/
// DIFFÉRENCE vs VoirAnime : le sélecteur de serveur n'est PAS un blob JSON « LECTEUR »
// mais une NAVIGATION : chaque <option data-redirect=".../?host=LECTEUR VOE"> recharge
// la page de lecture avec ?host= et sert une <iframe> différente. On fetch donc la page
// une fois PAR serveur pour récolter les embeds. Hôtes exploitables : VOE (voe.sx) +
// myTV (voembed.net -> voe). MOON (filemoon/mfw) & SB (streamhide) NON extractibles pour
// l'instant (TODO). Cloudflare REFERER-gaté : un Referer du site suffit (pas d'empreinte
// TLS -> axios OK, pas besoin de curl).

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const SCRAPE_TIMEOUT_MS = 15000;
const MAX_EXTRACTIONS = 6;
const MAX_HOSTS = 4;      // au plus 4 variantes ?host= à sonder par épisode
const MAX_VARIANTS = 2;   // au plus une fiche VF + une VOSTFR

const siteEndpoints = makeEndpointConfig('mavanime-endpoints.json', 'MAVANIME_ENDPOINTS_CONFIG', {
  base: 'https://mavanime.top',
});
export const reloadMavanimeEndpoints = siteEndpoints.reload;
export const getMavanimeEndpoints = siteEndpoints.get;
const SITE_BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const SEARCH_ITEM_RX = /<h3[^>]*>\s*<a\s+href="(https?:\/\/[a-z0-9.-]+\/anime\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
const CHAPTER_RX = /<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]{0,300}?<a\s+href="(https?:\/\/[a-z0-9.-]+\/anime\/[^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g;
const HOST_OPT_RX = /data-redirect="([^"]*\?host=[^"]+)"/g; // variantes de serveur
const IFRAME_RX = /<iframe[^>]+src=["']([^"']+)/i;

const agent = makeDnsSafeAgent();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface MavanimeStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR
  server: string;
  headers?: Record<string, string>;
}

// CF est REFERER-gaté : chaque requête porte un Referer (le site, ou la page parente).
async function getHtml(url: string, referer?: string): Promise<string | null> {
  try {
    const { data, status } = await axios.get<string>(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        Referer: referer || `${SITE_BASE()}/`,
      },
      timeout: SCRAPE_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
      validateStatus: () => true, maxRedirects: 4, decompress: true, httpsAgent: agent,
    });
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

function normalizeTitle(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\((?:vf|vostfr|vost|vo|multi)\)/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[^a-z0-9]+/g, '').trim();
}

function slugify(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function languageOf(url: string, title: string): string {
  const slug = url.replace(/\/+$/, '').split('/').pop() || '';
  if (/-vf$/.test(slug) || /-vf-/.test(slug) || /\(\s*vf\s*\)/i.test(title)) return 'VF';
  return 'VOSTFR';
}

function serverName(url: string, fallback: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/(^|\.)mail\.ru$/.test(h)) return 'mailru';
    return h.split('.')[0] || fallback;
  } catch { return fallback; }
}

// Bases de slug à essayer (romaji AniList prioritaire — Madara indexe en romaji).
// Découpage par saison comme VoirAnime (S2 = -2 / -saison-2).
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

interface Candidate { url: string; title: string; language: string; }

async function searchSite(keyword: string, wantedTitles: string[]): Promise<Candidate[]> {
  const html = await getHtml(`${SITE_BASE()}/?s=${encodeURIComponent(keyword)}&post_type=wp-manga`, `${SITE_BASE()}/`);
  if (!html) return [];
  const wanted = expandTitles(wantedTitles);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(SEARCH_ITEM_RX)) {
    const url = m[1]; const name = m[2].trim();
    if (seen.has(url)) continue;
    seen.add(url);
    if (!titlesMatch(wanted, name)) continue;
    out.push({ url, title: name, language: languageOf(url, name) });
  }
  const byLang = new Map<string, Candidate>();
  for (const c of out.sort((a, b) => normalizeTitle(a.title).length - normalizeTitle(b.title).length)) {
    if (!byLang.has(c.language)) byLang.set(c.language, c);
  }
  return [...byLang.values()].slice(0, MAX_VARIANTS);
}

function episodeNumberOf(label: string, url: string): number | null {
  const slug = url.replace(/\/+$/, '').split('/').pop() || '';
  const kw = label.match(/(?:épisode|episode|ep)\s*0*(\d+)/i) || slug.match(/-(?:episode|ep)-0*(\d+)/i);
  if (kw) return Number(kw[1]);
  const fromSlug = slug.match(/-0*(\d{1,4})(?:-(?:vf|vostfr|vost|vo|multi))/i);
  if (fromSlug) return Number(fromSlug[1]);
  const fromLabel = label.match(/(?:^|[\s-])0*(\d{1,4})\s*$/);
  if (fromLabel) return Number(fromLabel[1]);
  return null;
}

function episodePageFromHtml(html: string, episode?: number): string | null {
  const chapters: { url: string; label: string }[] = [];
  for (const m of html.matchAll(CHAPTER_RX)) {
    chapters.push({ url: m[1], label: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  if (chapters.length === 0) return null;
  if (!episode) return chapters[0].url;
  for (const c of chapters) {
    if (episodeNumberOf(c.label, c.url) === episode) return c.url;
  }
  return null;
}

// Récolte les embeds d'une page de lecture : iframe par défaut + une par variante ?host=.
async function embedsFrom(readingUrl: string): Promise<string[]> {
  const html = await getHtml(readingUrl, `${SITE_BASE()}/`);
  if (!html) return [];
  const variantUrls = new Set<string>();
  for (const m of html.matchAll(HOST_OPT_RX)) {
    const rel = m[1].replace(/&amp;/g, '&');
    try { variantUrls.add(new URL(rel, SITE_BASE()).toString()); } catch { /* skip */ }
  }
  const targets = [readingUrl, ...[...variantUrls].slice(0, MAX_HOSTS)];
  const pages = await Promise.all(targets.map(async (u, i) =>
    i === 0 ? html : await getHtml(u, readingUrl)));
  const embeds = new Set<string>();
  for (const page of pages) {
    if (!page) continue;
    const m = page.match(IFRAME_RX);
    if (m && /^https?:\/\//i.test(m[1])) embeds.add(m[1]);
  }
  return [...embeds];
}

async function extractAll(embeds: string[], language: string, extractorConfig: ExtractorConfig): Promise<MavanimeStream[]> {
  const supported = embeds.filter(u => { try { return detectExtractor(u) !== null; } catch { return false; } });
  if (supported.length === 0) return [];
  const seen = new Set<string>();
  const deduped = supported.filter(u => {
    const s = serverName(u, 'mavanime');
    if (seen.has(s)) return false; seen.add(s); return true;
  }).slice(0, MAX_EXTRACTIONS);

  const extracted = await Promise.all(deduped.map(async u => {
    try {
      const r = await extractStream(u, extractorConfig);
      if (!r?.url) return null;
      return { server: serverName(u, 'mavanime'), r };
    } catch { return null; }
  }));

  const streams: MavanimeStream[] = [];
  for (const item of extracted) {
    if (!item) continue;
    streams.push({ url: item.r.url, quality: item.r.quality || 'HD', language, server: item.server, headers: item.r.headers });
  }
  return streams;
}

export async function getMavanimeStreams(
  id: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season: number | undefined,
  episode: number | undefined,
  title: string,
  originalTitle?: string,
  altTitles: string[] = [],
): Promise<MavanimeStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && !episode) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = mediaType === 'series'
    ? `mavanime:${mode}:series:${id}:${season || 1}:${episode}`
    : `mavanime:${mode}:movie:${id || normalizeTitle(title)}`;
  const titles = [...new Set([...altTitles, originalTitle, title].filter(Boolean) as string[])];
  return cached(
    key, STREAMS_TTL_MS,
    async () => { const s = await fetchMavanimeStreams(mediaType, titles, season, episode, extractorConfig); return applyMultiAudio(s); },
    { scope: 'mavanime', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchMavanimeStreams(
  mediaType: 'movie' | 'series', titles: string[], season: number | undefined, episode: number | undefined, extractorConfig: ExtractorConfig,
): Promise<MavanimeStream[]> {
  const ep = mediaType === 'series' ? episode : undefined;
  const bases = slugBasesFor(titles, mediaType === 'series' ? season : undefined);

  // 1. Slugs directs (VOSTFR + VF), on ne retient que celui qui a l'épisode demandé.
  for (const base of bases) {
    const fiches: { lang: string; reading: string }[] = [];
    for (const [suffix, lang] of [['', 'VOSTFR'], ['-vf', 'VF']] as const) {
      const html = await getHtml(`${SITE_BASE()}/anime/${base}${suffix}/`, `${SITE_BASE()}/`);
      if (!html || !/wp-manga-chapter/.test(html)) continue;
      const reading = episodePageFromHtml(html, ep);
      if (reading) fiches.push({ lang, reading });
    }
    if (fiches.length === 0) continue;
    const groups = await Promise.all(fiches.map(async f => {
      const embeds = await embedsFrom(f.reading);
      if (embeds.length === 0) return [] as MavanimeStream[];
      console.log(`[Mavanime] ${f.lang} (${base}): ${embeds.length} embed(s)`);
      return extractAll(embeds, f.lang, extractorConfig);
    }));
    const streams = groups.flat();
    if (streams.length) { console.log(`[Mavanime] ${streams.length} stream(s) [${base}]`); return streams; }
  }

  // 2. Repli recherche (S1 seulement — pas de ciblage de saison fiable).
  if (!season || season <= 1) {
    for (const t of titles) {
      const cands = await searchSite(t, titles);
      const groups = await Promise.all(cands.map(async c => {
        const html = await getHtml(c.url, `${SITE_BASE()}/`);
        const reading = html ? episodePageFromHtml(html, ep) : null;
        if (!reading) return [] as MavanimeStream[];
        const embeds = await embedsFrom(reading);
        return extractAll(embeds, c.language, extractorConfig);
      }));
      const streams = groups.flat();
      if (streams.length) { console.log(`[Mavanime] ${streams.length} stream(s) [search:${t}]`); return streams; }
    }
  }
  console.log(`[Mavanime] Aucun stream pour "${titles[0]}"`);
  return [];
}

/** Sonde de santé : la recherche répond-elle avec des fiches anime ? */
export async function mavanimeProbe(): Promise<boolean> {
  const html = await getHtml(`${SITE_BASE()}/?s=one+piece&post_type=wp-manga`, `${SITE_BASE()}/`);
  return !!html && /\/anime\/[a-z0-9-]+\//i.test(html); // regex locale non-globale (sans état)
}

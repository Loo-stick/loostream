import axios from 'axios';
import { extractStream, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';

// Coflix — films & séries FR généralistes, VF ET VOSTFR (versions séparées).
// Provider Onyx CoflixSourceProvider. WordPress + endpoints ajax :
//   Recherche : /ajax/search/suggest?keyword={titre}  -> {html} items
//               <a href="/film/{slug}/ep-{episodeId}" data-jp="{titre}"> + dot Movie/Series
//   Film   : episodeId = l'ep-id de l'item.
//   Série  : page saison -> data-id="{movieId}" -> /ajax/episode/list-episode?movieId={movieId}
//            -> <a data-num="{ep}" data-id="{episodeId}"> ; slug porte "Saison-{N}".
//   Player : /ajax/episode/player?episode_id={episodeId} -> [{server_link, version}]
// Version depuis le slug (-vf / -vostfr / -truefrench) confirmée par le player.
// Domaines TRÈS rotatifs + rate-limit 429 (cooldown) -> résilience multi-domaines.

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const MAX_VARIANTS = 4;       // fiches (versions) traitées par requête
const MAX_EXTRACTIONS = 6;    // extractions d'hôtes au total

const siteEndpoints = makeEndpointConfig('coflix-endpoints.json', 'COFLIX_ENDPOINTS_CONFIG', {
  base: 'https://coflix.wiki',
});
export const reloadCoflixEndpoints = siteEndpoints.reload;
export const getCoflixEndpoints = siteEndpoints.get;

// Domaines de repli si le base configuré tombe / renvoie 429. Le base configuré
// (éditable à chaud) est essayé en premier.
const FALLBACK_DOMAINS = ['https://coflix.wiki', 'https://coflix.cloud', 'https://coflix.domains'];
function domainCandidates(): string[] {
  const base = siteEndpoints.get().base.replace(/\/$/, '');
  return [base, ...FALLBACK_DOMAINS.filter(d => d !== base)];
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};
const AJAX_HEADERS = { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest' };

export interface CoflixStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR | VO | MULTI
  server: string;
  headers?: Record<string, string>;
}

function normalize(t: string): string {
  return (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Version déduite du slug de la fiche.
function versionFromSlug(slug: string): string {
  const s = slug.toLowerCase();
  if (/vostfr/.test(s)) return 'VOSTFR';
  if (/(^|-)(vf|truefrench|french)(-|$)/.test(s)) return 'VF';
  return 'VF'; // sans suffixe -> VF par défaut (confirmé par le player)
}

function normalizeLangTag(v: string): string {
  const l = (v || '').toUpperCase();
  if (l.includes('MULTI')) return 'MULTI';
  if (l.includes('VOSTFR') || l.includes('VOST')) return 'VOSTFR';
  if (l === 'VO' || l.includes('ORIGINAL')) return 'VO';
  if (l.includes('VF') || l.includes('TRUEFRENCH') || l.includes('FRENCH')) return 'VF';
  return 'VF';
}

function serverName(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/uqload/.test(h)) return 'uqload';
    return h.split('.')[0] || 'coflix';
  } catch { return 'coflix'; }
}

interface SuggestItem { episodeId: string; slug: string; title: string; type: string; }

const ITEM_RX = /<a class="item"\s+href="([^"]+\/ep-(\d+))"[\s\S]*?data-jp="([^"]*)"[\s\S]*?<span class="dot">([^<]+)<\/span>/gi;

async function firstOk<T>(fn: (base: string) => Promise<T | null>): Promise<T | null> {
  for (const base of domainCandidates()) {
    const r = await fn(base);
    if (r !== null) return r;
  }
  return null;
}

async function fetchText(url: string, ajax: boolean): Promise<string | null> {
  try {
    const { data, status } = await axios.get<string>(url, {
      headers: ajax ? AJAX_HEADERS : HEADERS,
      timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
      validateStatus: () => true, maxRedirects: 4,
    });
    if (status === 429) { console.log('[Coflix] 429 rate-limited'); return null; }
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

// {html:"..."} des endpoints ajax -> le HTML interne (déséchappé par JSON.parse).
function unwrapAjaxHtml(raw: string): string {
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.html === 'string') return j.html;
  } catch { /* pas du JSON */ }
  return raw;
}

async function searchSuggest(title: string): Promise<{ base: string; items: SuggestItem[] } | null> {
  return firstOk(async base => {
    const raw = await fetchText(`${base}/ajax/search/suggest?keyword=${encodeURIComponent(title)}`, true);
    if (!raw) return null;
    const html = unwrapAjaxHtml(raw);
    const items: SuggestItem[] = [];
    for (const m of html.matchAll(ITEM_RX)) {
      const slug = (m[1].split('/film/')[1] || m[1]).replace(/\/ep-\d+.*$/, '');
      items.push({ episodeId: m[2], slug, title: m[3], type: (m[4] || '').trim() });
    }
    return items.length ? { base, items } : null;
  });
}

async function getPlayerServers(base: string, episodeId: string): Promise<{ link: string; version: string }[]> {
  const raw = await fetchText(`${base}/ajax/episode/player?episode_id=${episodeId}`, true);
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (!j?.status || !Array.isArray(j.message)) return [];
    return j.message
      .filter((s: any) => typeof s?.server_link === 'string' && /^https?:\/\//.test(s.server_link))
      .map((s: any) => ({ link: s.server_link as string, version: String(s.version || '') }));
  } catch { return []; }
}

// Série : page saison -> movieId (data-id) -> list-episode -> episodeId de l'ép.
async function resolveEpisodeId(base: string, slug: string, seasonEpId: string, episode: number): Promise<string | null> {
  const page = await fetchText(`${base}/film/${slug}/ep-${seasonEpId}`, false);
  if (!page) return null;
  const movieId = page.match(/data-id="(\d+)"/)?.[1];
  if (!movieId) return null;
  const raw = await fetchText(`${base}/ajax/episode/list-episode?movieId=${movieId}`, true);
  if (!raw) return null;
  const html = unwrapAjaxHtml(raw);
  for (const m of html.matchAll(/data-num="(\d+)"\s+data-id="(\d+)"/gi)) {
    if (Number(m[1]) === episode) return m[2];
  }
  return null;
}

async function extractServers(
  servers: { link: string; version: string }[], slugVersion: string, extractorConfig: ExtractorConfig
): Promise<CoflixStream[]> {
  const seen = new Set<string>();
  const picked = servers.filter(s => {
    const key = serverName(s.link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_EXTRACTIONS);

  const extracted = await Promise.all(picked.map(async (s): Promise<CoflixStream | null> => {
    try {
      const r = await extractStream(s.link, extractorConfig);
      if (!r?.url) return null;
      // Le champ `version` du player est peu fiable (souvent "VF" même sur une
      // fiche vostfr). La version de la FICHE (slug) est le signal autoritaire.
      const lang = normalizeLangTag(slugVersion);
      console.log(`[Coflix] Extracted ${serverName(s.link)} (${lang}): ${r.format}`);
      return { url: r.url, quality: r.quality || 'HD', language: lang, server: serverName(s.link), headers: r.headers };
    } catch { return null; }
  }));
  return extracted.filter((x): x is CoflixStream => x !== null);
}

export async function getCoflixStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season: number | undefined,
  episode: number | undefined,
  title: string,
  originalTitle?: string
): Promise<CoflixStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const key = mediaType === 'series'
    ? `coflix:series:${normalize(title)}:${season}:${episode}`
    : `coflix:movie:${normalize(title)}`;
  const titles = [...new Set([title, originalTitle].filter(Boolean) as string[])];
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchCoflixStreams(mediaType, titles, season, episode, extractorConfig),
    { scope: 'coflix', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchCoflixStreams(
  mediaType: 'movie' | 'series', titles: string[], season: number | undefined,
  episode: number | undefined, extractorConfig: ExtractorConfig
): Promise<CoflixStream[]> {
  let found: { base: string; items: SuggestItem[] } | null = null;
  for (const t of titles) {
    found = await searchSuggest(t);
    if (found) break;
  }
  if (!found) { console.log(`[Coflix] Aucun résultat pour "${titles[0]}"`); return []; }
  const { base, items } = found;
  const targets = titles.map(normalize);

  // Sélectionne les fiches pertinentes (film ou saison), une par version.
  const byVersion = new Map<string, SuggestItem>();
  for (const it of items) {
    const isSeries = /series|série|saison/i.test(it.type) || /saison/i.test(it.slug);
    if (mediaType === 'series' && !isSeries) continue;
    if (mediaType === 'movie' && isSeries) continue;

    if (mediaType === 'series') {
      const sm = it.slug.match(/saison[-\s]?(\d+)/i);
      if (!sm || Number(sm[1]) !== season) continue;
    }
    // Titre : le slug (hors saison/version) doit matcher le titre demandé.
    const cleanSlug = normalize(it.slug.replace(/saison[-\s]?\d+/i, '').replace(/(vostfr|truefrench|vf|french)$/i, ''));
    const ok = targets.some(t => t && (cleanSlug.includes(t) || t.includes(cleanSlug)));
    if (!ok) continue;

    const v = versionFromSlug(it.slug);
    if (!byVersion.has(v)) byVersion.set(v, it);
  }

  const variants = [...byVersion.values()].slice(0, MAX_VARIANTS);
  if (variants.length === 0) { console.log(`[Coflix] Pas de fiche correspondante pour "${titles[0]}"`); return []; }

  const groups = await Promise.all(variants.map(async it => {
    const episodeId = mediaType === 'series'
      ? await resolveEpisodeId(base, it.slug, it.episodeId, episode!)
      : it.episodeId;
    if (!episodeId) return [] as CoflixStream[];
    const servers = await getPlayerServers(base, episodeId);
    if (servers.length === 0) return [] as CoflixStream[];
    return extractServers(servers, versionFromSlug(it.slug), extractorConfig);
  }));

  const streams = groups.flat();
  console.log(`[Coflix] Returning ${streams.length} stream(s) pour "${titles[0]}"`);
  return streams;
}

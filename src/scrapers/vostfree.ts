import axios from 'axios';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';
import { titlesMatch } from '../matching';

// Vostfree — anime VF & VOSTFR (ipv4.vostfree.ws). CMS DataLife Engine (DLE), SSR HTML.
//   Recherche : POST /index.php?do=search (story=<titre>) -> pages /<id>-<slug>-(vf|vostfr)-…​.html
//   Page anime : divs <div id="content_player_N" class="player_box">EMBED</div>, groupés par
//     épisode (N hôtes/épisode). Sibnet = id numérique (video.sibnet.ru/shell.php?videoid=),
//     Uqload = code (uqload.cx/embed-<code>.html) ; Streamsb/Vudeo/Mytv = ignorés (non extractibles).
//   VF vs VOSTFR = pages séparées (marqueur dans l'URL). Keyé par TITRE (comme AnimeSama/VoirAnime),
//   numérotation ABSOLUE des épisodes.

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const MAX_EXTRACTIONS = 4;
const MAX_CANDIDATES = 2; // au plus une page VF + une VOSTFR

const endpoints = makeEndpointConfig('vostfree-endpoints.json', 'VOSTFREE_ENDPOINTS_CONFIG', {
  base: 'https://ipv4.vostfree.ws',
});
export const reloadVostfreeEndpoints = endpoints.reload;
export const getVostfreeEndpoints = endpoints.get;
const BASE = () => endpoints.get().base.replace(/\/+$/, '');
const UQLOAD_TLD = 'uqload.cx';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

export interface VostfreeStream {
  url: string; quality: string; language: string; server: string; headers?: Record<string, string>;
}

async function getHtml(url: string, post?: string): Promise<string | null> {
  try {
    const { data, status } = await axios.request<string>({
      url, method: post !== undefined ? 'POST' : 'GET', data: post,
      headers: post !== undefined ? { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' } : HEADERS,
      timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
      validateStatus: () => true, maxRedirects: 4, decompress: true,
    });
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

// ⚠️ tester le CHEMIN, pas l'URL entière : le domaine « vostfree » contient « vostfr »
// et classerait tout en VOSTFR.
const urlPath = (url: string): string => url.replace(/^https?:\/\/[^/]+/, '');

function languageOf(url: string): string {
  const p = urlPath(url);
  return /-vf[-.]/i.test(p) && !/vostfr/i.test(p) ? 'VF' : 'VOSTFR';
}

interface Candidate { url: string; language: string }

// N° de saison depuis le nom + le CHEMIN (les slugs séparent par tirets : « saison-3 »,
// « -s4-part-2- »). Le nom peut finir par la langue (« … Kyojin 2 VOSTFR »). Défaut 1.
function seasonOf(name: string, url: string): number {
  const p = urlPath(url).toLowerCase();
  const n = name.toLowerCase();
  const m = n.match(/\bsaison[\s-]*(\d{1,2})\b/) || p.match(/saison[\s-]*(\d{1,2})/)
    || p.match(/[-/]s(\d{1,2})(?:[-_]|$)/)
    || n.match(/(\d{1,2})\s*(?:vf|vostfr|vost|french|multi|vo)?\s*$/);
  return m ? Number(m[1]) : 1;
}

// Retire marqueurs de saison/langue/part pour le matching de titre STRICT (sinon le
// numéro de saison en trop fait échouer titlesMatch : « Shingeki no Kyojin 4 » ⊄ requête).
function stripSeason(name: string): string {
  return name
    .replace(/\((?:vf|vostfr|vost|vo|multi|french)\)/ig, '')
    .replace(/\b(?:saison|season|s)\s*\d{1,2}\b/ig, '')
    .replace(/\bpart(?:ie)?\s*\d+\b/ig, '')
    .replace(/\b(?:vf|vostfr|vost|french)\b/ig, '')
    .replace(/\s+\d{1,2}\s*$/, '') // numéro final isolé (« … Kyojin 4 »)
    .replace(/\s+/g, ' ').trim();
}

// Recherche DLE -> une page par langue POUR LA SAISON voulue. Essaie plusieurs titres
// (le titre TMDB anglais renvoie souvent 0 ; le romaji / FR matche). S'arrête dès qu'on
// a VF + VOSTFR.
async function search(titles: string[], wantSeason: number): Promise<Candidate[]> {
  const rx = /href="(https?:\/\/[a-z0-9.-]*vostfree[^"]*?\/\d+-[^"]+\.html)"[^>]*>([^<]{2,120})<\/a>/gi;
  const byLang = new Map<string, Candidate>();
  for (const q of titles.slice(0, 4)) {
    if (byLang.size >= MAX_CANDIDATES) break;
    const html = await getHtml(`${BASE()}/index.php?do=search`,
      `do=search&subaction=search&search_start=0&full_search=0&story=${encodeURIComponent(q)}`);
    if (!html) continue;
    let m: RegExpExecArray | null;
    rx.lastIndex = 0;
    while ((m = rx.exec(html))) {
      const url = m[1];
      const base = stripSeason(m[2]);
      if (!titlesMatch(titles, base)) continue;      // faux titre -> écarté
      if (seasonOf(m[2], url) !== wantSeason) continue; // autre saison -> écartée
      const lang = languageOf(url);
      if (!byLang.has(lang)) byLang.set(lang, { url, language: lang });
    }
  }
  return [...byLang.values()];
}

// Embeds de l'épisode voulu — MAPPING EXACT via la structure DLE :
//   <div id="buttons_N">…<div id="player_M" class="new_player_<hôte>">…</div>…</div>  (N = épisode)
//   <div id="content_player_M" class="player_box">VALEUR</div>                          (M = même id)
// Le type d'hôte vient de la classe (pas de devinette de format), l'épisode du bloc buttons_N.
function episodeEmbeds(html: string, episode: number): { url: string; server: string }[] {
  // Valeur d'embed indexée par id de player.
  const values = new Map<number, string>();
  for (const m of html.matchAll(/<div id="content_player_(\d+)"[^>]*>([^<]+)<\/div>/g)) {
    values.set(Number(m[1]), m[2].trim());
  }
  if (!values.size) return [];
  // Bloc de boutons de l'épisode (jusqu'au prochain buttons_ ou la fin de la zone lecteur).
  const btn = html.match(new RegExp(
    `<div id="buttons_${episode}"[^>]*>([\\s\\S]*?)(?=<div id="buttons_\\d|<div class="new_player_content")`, 'i'));
  if (!btn) return [];
  const out: { url: string; server: string }[] = [];
  for (const pm of btn[1].matchAll(/<div id="player_(\d+)"[^>]*class="[^"]*new_player_([a-z0-9]+)/gi)) {
    const v = values.get(Number(pm[1]));
    if (!v) continue;
    const host = pm[2].toLowerCase();
    if (host === 'sibnet') out.push({ url: `https://video.sibnet.ru/shell.php?videoid=${v}`, server: 'sibnet' });
    else if (host === 'uqload') out.push({ url: `https://${UQLOAD_TLD}/embed-${v}.html`, server: 'uqload' });
    // Mytv/Streamsb/Vudeo/… -> ignorés (non extractibles chez nous)
  }
  return out;
}

async function extractAll(
  embeds: { url: string; server: string }[], language: string, extractorConfig: ExtractorConfig,
): Promise<VostfreeStream[]> {
  const supported = embeds.filter(e => { try { return detectExtractor(e.url) !== null; } catch { return false; } });
  if (!supported.length) return [];
  const seen = new Set<string>();
  const deduped = supported.filter(e => { if (seen.has(e.server)) return false; seen.add(e.server); return true; }).slice(0, MAX_EXTRACTIONS);
  const extracted = await Promise.all(deduped.map(async e => {
    try {
      const r = await extractStream(e.url, extractorConfig);
      if (!r?.url) return null;
      console.log(`[Vostfree] Extracted ${e.server} (${language}): ${r.format}`);
      return { e, r };
    } catch { return null; }
  }));
  const streams: VostfreeStream[] = [];
  for (const item of extracted) {
    if (!item) continue;
    streams.push({ url: item.r.url, quality: item.r.quality || 'HD', language, server: item.e.server, headers: item.r.headers });
  }
  return streams;
}

export async function getVostfreeStreams(
  id: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season: number | undefined,
  episode: number | undefined,
  titles: string[],
): Promise<VostfreeStream[]> {
  const uniq = [...new Set(titles.filter(Boolean))];
  if (!uniq.length) return [];
  if (mediaType === 'series' && !episode) return [];
  const ep = mediaType === 'series' ? episode! : 1;
  const wantSeason = mediaType === 'series' ? (season || 1) : 1;
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = `vostfree:${mode}:${uniq[0].toLowerCase()}:${wantSeason}:${ep}`;
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchVostfree(uniq, wantSeason, ep, extractorConfig),
    { scope: 'vostfree', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchVostfree(
  titles: string[], wantSeason: number, ep: number, extractorConfig: ExtractorConfig,
): Promise<VostfreeStream[]> {
  const candidates = await search(titles, wantSeason);
  if (!candidates.length) { console.log(`[Vostfree] Aucun match pour "${titles[0]}"`); return []; }
  const perLang = await Promise.all(candidates.map(async c => {
    const html = await getHtml(c.url);
    if (!html) return [] as VostfreeStream[];
    const embeds = episodeEmbeds(html, ep);
    if (!embeds.length) return [] as VostfreeStream[];
    return extractAll(embeds, c.language, extractorConfig);
  }));
  const streams = perLang.flat();
  console.log(`[Vostfree] "${titles[0]}" ép ${ep} -> ${streams.length} flux (${candidates.map(c => c.language).join('+')})`);
  return streams;
}

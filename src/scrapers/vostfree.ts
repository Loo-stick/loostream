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

function languageOf(url: string): string {
  return /-vf[-.]/i.test(url) && !/vostfr/i.test(url) ? 'VF' : 'VOSTFR';
}

interface Candidate { url: string; language: string }

// Recherche DLE -> pages anime matchant le titre (une par langue).
async function search(titles: string[]): Promise<Candidate[]> {
  const html = await getHtml(`${BASE()}/index.php?do=search`,
    `do=search&subaction=search&search_start=0&full_search=0&story=${encodeURIComponent(titles[0])}`);
  if (!html) return [];
  const rx = /href="(https?:\/\/[a-z0-9.-]*vostfree[^"]*?\/\d+-[^"]+\.html)"[^>]*>([^<]{2,120})<\/a>/gi;
  const byLang = new Map<string, Candidate>();
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html)) && byLang.size < MAX_CANDIDATES) {
    const url = m[1];
    const name = m[2].replace(/\((?:vf|vostfr|vost)\)/ig, '').trim();
    if (!titlesMatch(titles, name)) continue; // évite les faux titres
    const lang = languageOf(url);
    if (!byLang.has(lang)) byLang.set(lang, { url, language: lang });
  }
  return [...byLang.values()];
}

// Embeds Sibnet + Uqload de l'épisode voulu sur une page anime. Les content_player sont
// groupés par épisode (perEp hôtes chacun) ; on classe par FORMAT (robuste à l'ordre).
function episodeEmbeds(html: string, episode: number): { url: string; server: string }[] {
  const cps: string[] = [];
  const rx = /<div id="content_player_\d+"[^>]*>([^<]+)<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html))) cps.push(m[1].trim());
  if (!cps.length) return [];
  const epCount = (html.match(/<option[^>]*>\s*Episode/gi) || []).length || 1;
  const perEp = Math.max(1, Math.round(cps.length / epCount));
  const block = cps.slice((episode - 1) * perEp, (episode - 1) * perEp + perEp);
  const out: { url: string; server: string }[] = [];
  for (const v of block) {
    if (/^\d{4,}$/.test(v)) out.push({ url: `https://video.sibnet.ru/shell.php?videoid=${v}`, server: 'sibnet' });
    else if (/^[a-z0-9]{10,14}$/i.test(v)) out.push({ url: `https://${UQLOAD_TLD}/embed-${v}.html`, server: 'uqload' });
    // Streamsb/Vudeo/Mytv (URLs http complètes ou ids longs) -> ignorés (non extractibles)
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
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = `vostfree:${mode}:${uniq[0].toLowerCase()}:${season || 1}:${ep}`;
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchVostfree(uniq, mediaType, ep, extractorConfig),
    { scope: 'vostfree', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchVostfree(
  titles: string[], mediaType: 'movie' | 'series', ep: number, extractorConfig: ExtractorConfig,
): Promise<VostfreeStream[]> {
  const candidates = await search(titles);
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

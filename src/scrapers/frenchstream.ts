import axios from 'axios';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { extractStream, detectExtractor, ExtractorConfig, ExtractorId } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';

// FrenchStream is a DataLife-Engine (DLE) site whose front domain rotates
// (fs03.lol -> fs21.lol -> ...). The stable portal fstream.info publishes the
// current domain. We resolve it at runtime (cached) AND read a manual override
// from config/frenchstream-endpoints.json (bot-editable, hot-reloaded) — same
// pattern as movix/flemmix.
interface FrenchStreamEndpoints {
  portal: string; // tracks the current base, e.g. http://fstream.info/
  base: string;   // current front domain, e.g. https://fs21.lol
}

const DEFAULT_ENDPOINTS: FrenchStreamEndpoints = {
  portal: 'http://fstream.info/',
  base: 'https://fs21.lol',
};

const ENDPOINTS_PATH = process.env.FRENCHSTREAM_ENDPOINTS_CONFIG ||
  (fs.existsSync('/app/config/frenchstream-endpoints.json')
    ? '/app/config/frenchstream-endpoints.json'
    : path.join(process.cwd(), 'config', 'frenchstream-endpoints.json'));

let endpoints: FrenchStreamEndpoints = { ...DEFAULT_ENDPOINTS };

function loadEndpoints(): void {
  try {
    if (fs.existsSync(ENDPOINTS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(ENDPOINTS_PATH, 'utf-8'));
      if (raw.base) {
        endpoints = {
          portal: raw.portal || DEFAULT_ENDPOINTS.portal,
          base: raw.base.replace(/\/+$/, ''),
        };
        console.log(`[FrenchStream] Endpoints loaded: base=${endpoints.base}`);
        return;
      }
    }
  } catch (e: any) {
    console.error(`[FrenchStream] Error loading endpoints: ${e.message}`);
  }
  endpoints = { ...DEFAULT_ENDPOINTS };
  console.log(`[FrenchStream] Using default endpoints: base=${endpoints.base}`);
}

export function reloadFrenchStreamEndpoints(): FrenchStreamEndpoints {
  loadEndpoints();
  resolvedBase = null; // force a fresh portal resolve on next call
  return { ...endpoints };
}

export function getFrenchStreamEndpoints(): FrenchStreamEndpoints {
  return { ...endpoints };
}

loadEndpoints();

try {
  if (fs.existsSync(ENDPOINTS_PATH)) {
    fs.watch(ENDPOINTS_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[FrenchStream] Endpoints file changed, reloading...');
        setTimeout(loadEndpoints, 100);
      }
    });
  }
} catch {
  // watch not supported
}

const STREAMS_TTL_MS = 15 * 60 * 1000;
const TMDB_TTL_MS = 12 * 60 * 60 * 1000;
const BASE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const REQ_TIMEOUT_MS = 12000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

export interface FrenchStreamStream {
  name: string;
  title: string;
  url: string;
  quality: string;
  language: string;
  server: string;
  headers?: Record<string, string>;
}

// Resolve the live front domain from the portal page. The portal lists it in
// <div class="url-card"><a href="https://fsNN.lol">; fall back to any fs<digits>
// domain in the page, then to the configured endpoint.
let resolvedBase: string | null = null;
let resolvedAt = 0;

async function currentBase(force = false): Promise<string> {
  if (!force && resolvedBase && Date.now() - resolvedAt < BASE_TTL_MS) {
    return resolvedBase;
  }
  try {
    const { data: html } = await axios.get(endpoints.portal, {
      headers: HEADERS,
      timeout: 10000,
      maxRedirects: 5,
    });
    const cardMatch = String(html).match(/url-card[\s\S]{0,300}?href="(https?:\/\/[^"]+)"/i);
    const fsMatch = String(html).match(/https?:\/\/fs\d+\.[a-z]{2,}/i);
    const found = (cardMatch?.[1] || fsMatch?.[0])?.replace(/\/+$/, '');
    if (found) {
      resolvedBase = found;
      resolvedAt = Date.now();
      if (found !== endpoints.base) {
        console.log(`[FrenchStream] Portal resolved new base: ${found} (config: ${endpoints.base})`);
      }
      return resolvedBase;
    }
  } catch (e: any) {
    console.log(`[FrenchStream] Portal resolve failed: ${e.message}`);
  }
  return endpoints.base;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/\\'/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function normalize(s: string): string {
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccard(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter(w => w.length > 1));
  const wb = new Set(b.split(' ').filter(w => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  const inter = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return inter / union;
}

interface SearchResult {
  newsId: string;
  title: string;     // raw title incl. "(YYYY)" and/or "- Saison N"
  year: string | null;
  season: number | null;
}

// POST /engine/ajax/search.php query=... -> HTML list of
// <div class='search-item' onclick="location.href='/NNNN-slug.html'">
//   ... <div class='search-title'>Title (YYYY)</div>
function parseSearchHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const itemRegex = /class=['"]search-item['"][^>]*onclick="location\.href='([^']+)'"[\s\S]*?class=['"]search-title['"]>([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(html)) !== null) {
    const href = m[1].trim();
    const idMatch = href.match(/\/(\d+)-/);
    if (!idMatch) continue;
    const rawTitle = decodeEntities(m[2].trim());
    const yearMatch = rawTitle.match(/\((\d{4})\)/);
    const seasonMatch = href.match(/saison-(\d+)/i) || rawTitle.match(/saison\s+(\d+)/i);
    results.push({
      newsId: idMatch[1],
      title: rawTitle,
      year: yearMatch ? yearMatch[1] : null,
      season: seasonMatch ? parseInt(seasonMatch[1], 10) : null,
    });
  }
  return results;
}

async function search(base: string, query: string): Promise<SearchResult[]> {
  try {
    const body = new URLSearchParams({ query, page: '1' }).toString();
    const { data: html } = await axios.post(`${base}/engine/ajax/search.php`, body, {
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${base}/`,
      },
      timeout: REQ_TIMEOUT_MS,
    });
    return parseSearchHtml(String(html));
  } catch (e: any) {
    console.log(`[FrenchStream] Search failed: ${e.message}`);
    return [];
  }
}

interface EmbedLink {
  server: string;
  url: string;
  language: string;
  forced?: ExtractorId; // host type known from the provider name (bypasses domain allowlist)
}

// FrenchStream's provider keys authoritatively name the host. Map the ones
// MediaFlow can extract; voe/filemoon rotate domains so forcing the type is the
// only reliable way to resolve them.
const SERVER_TO_EXTRACTOR: Record<string, ExtractorId> = {
  voe: 'voe',
  dood: 'doodstream',
  doodstream: 'doodstream',
  filmoon: 'filemoon',
  filemoon: 'filemoon',
  uqload: 'uqload',
  vidmoly: 'vidmoly',
  mixdrop: 'mixdrop',
  streamtape: 'streamtape',
  streamwish: 'streamwish',
  swish: 'streamwish',
  vidoza: 'vidoza',
  lulustream: 'lulustream',
  lulu: 'lulustream',
};

function forcedFor(server: string): ExtractorId | undefined {
  return SERVER_TO_EXTRACTOR[server.toLowerCase().trim()];
}

// vff = TrueFrench, vfq = French (both VF); vostfr; vo = original.
function langLabel(key: string): string {
  if (key === 'vff' || key === 'vfq') return 'VF';
  if (key === 'vostfr') return 'VOSTFR';
  if (key === 'vo') return 'VO';
  return 'VF';
}

// FrenchStream routes some hosts through a redirect wrapper instead of linking
// the real embed: kakaflix.lol/.../newPlayer.php -> voe, kokoflix.lol/chamber_go.php
// -> filemoon. We must follow the redirect to get a URL our extractors recognise.
const WRAPPER_HOSTS = ['kakaflix.lol', 'kokoflix.lol'];
// Their TLS certs are sometimes mismatched; don't let that block resolution.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function isWrapper(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return WRAPPER_HOSTS.some(w => host === w || host.endsWith(`.${w}`));
  } catch {
    return false;
  }
}

// Wrapper timeouts dominate the addon's cold response time: the wrappers are
// resolved before extraction, so one dead endpoint stalls the whole source.
// Keep the budget short and remember dead endpoints for a while.
const WRAPPER_TIMEOUT_MS = 5000;
const WRAPPER_DEAD_TTL_MS = 10 * 60 * 1000;
const deadWrappers = new Map<string, number>();

// kakaflix serves several "chambers" (/sydney/, /tokyo/, …) and they die
// independently — one can hang forever while another answers in 400ms. So the
// cooldown key is host + first path segment, not just the host.
function wrapperKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.split('/').slice(0, 2).join('/')}`;
  } catch {
    return url;
  }
}

function isWrapperDead(url: string): boolean {
  const until = deadWrappers.get(wrapperKey(url));
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  deadWrappers.delete(wrapperKey(url));
  return false;
}

async function resolveWrapper(url: string): Promise<string> {
  if (isWrapperDead(url)) {
    console.log(`[FrenchStream] Wrapper skipped (en cooldown): ${wrapperKey(url)}`);
    return url;
  }
  // voe bounces through several rotation domains; the chain is flaky and can
  // ECONNRESET mid-way, so retry once — but never on a timeout, which means the
  // endpoint is hanging and a second attempt just doubles the wait.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await axios.get(url, {
        headers: { ...HEADERS, Referer: `${endpoints.base}/` },
        timeout: WRAPPER_TIMEOUT_MS,
        maxRedirects: 12,
        httpsAgent: insecureAgent,
        validateStatus: () => true,
      });
      const finalUrl: string | undefined = resp.request?.res?.responseUrl || resp.request?.responseURL;
      if (finalUrl && finalUrl !== url) {
        console.log(`[FrenchStream] Wrapper resolved: ${new URL(url).hostname} -> ${new URL(finalUrl).hostname}`);
        return finalUrl;
      }
      return url;
    } catch (e: any) {
      const timedOut = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT';
      if (timedOut) {
        deadWrappers.set(wrapperKey(url), Date.now() + WRAPPER_DEAD_TTL_MS);
        console.log(`[FrenchStream] Wrapper timeout, cooldown ${WRAPPER_DEAD_TTL_MS / 60000}min: ${wrapperKey(url)}`);
        return url;
      }
      if (attempt === 1) console.log(`[FrenchStream] Wrapper resolve failed (${url}): ${e.message}`);
    }
  }
  return url;
}

function collectEmbeds(langMap: Record<string, Record<string, string>>): EmbedLink[] {
  const embeds: EmbedLink[] = [];
  for (const [provider, byLang] of Object.entries(langMap || {})) {
    if (!byLang || typeof byLang !== 'object') continue;
    const seen = new Set<string>();
    for (const [lang, url] of Object.entries(byLang)) {
      if (lang === 'default') continue;
      if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      embeds.push({ server: provider, url, language: langLabel(lang), forced: forcedFor(provider) });
    }
  }
  return embeds;
}

// Movie embeds: GET /engine/ajax/film_api.php?id=<newsId> -> { players, meta:{tagz:"f-<tmdbId>"} }
async function fetchMovieEmbeds(base: string, newsId: string, tmdbId: string): Promise<EmbedLink[]> {
  try {
    const { data } = await axios.get(`${base}/engine/ajax/film_api.php?id=${newsId}`, {
      headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest', 'Cookie': 'dle_skin=VFV1', 'Referer': `${base}/` },
      timeout: REQ_TIMEOUT_MS,
    });
    // tagz carries the TMDB id ("f-550"): use it to confirm the match.
    const tagz: string = data?.meta?.tagz || '';
    if (tagz && /^f-\d+$/.test(tagz) && tagz !== `f-${tmdbId}`) {
      console.log(`[FrenchStream] tagz mismatch (${tagz} != f-${tmdbId}), skipping`);
      return [];
    }
    return collectEmbeds(data?.players || {});
  } catch (e: any) {
    console.log(`[FrenchStream] film_api failed: ${e.message}`);
    return [];
  }
}

// Episode embeds: GET /engine/ajax/sx.php?id=<seasonNewsId> -> { vf:{ep:{provider:url}}, vostfr, vo }
async function fetchEpisodeEmbeds(base: string, seasonNewsId: string, episode: number): Promise<EmbedLink[]> {
  try {
    const { data } = await axios.get(`${base}/engine/ajax/sx.php?id=${seasonNewsId}`, {
      headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest', 'Cookie': 'dle_skin=VFV1', 'Referer': `${base}/` },
      timeout: REQ_TIMEOUT_MS,
    });
    const embeds: EmbedLink[] = [];
    for (const [langKey, label] of [['vf', 'VF'], ['vostfr', 'VOSTFR'], ['vo', 'VO']] as const) {
      const epMap = data?.[langKey]?.[String(episode)];
      if (!epMap || typeof epMap !== 'object') continue;
      for (const [provider, url] of Object.entries(epMap as Record<string, string>)) {
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
        embeds.push({ server: provider, url, language: label, forced: forcedFor(provider) });
      }
    }
    return embeds;
  } catch (e: any) {
    console.log(`[FrenchStream] sx.php failed: ${e.message}`);
    return [];
  }
}

export async function getFrenchStreamStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  tmdbKey?: string,
  season?: number,
  episode?: number
): Promise<FrenchStreamStream[]> {
  const apiKey = tmdbKey || DEFAULT_TMDB_API_KEY;
  if (!apiKey) {
    console.log('[FrenchStream] No TMDB API key, skipping');
    return [];
  }
  if (mediaType === 'series' && (!season || !episode)) return [];

  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = `frenchstream:${mode}:${mediaType}:${tmdbId}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    async () => { const s = await fetchFrenchStreamStreams(tmdbId, mediaType, apiKey, extractorConfig, season, episode); return applyMultiAudio(s); },
    { scope: 'frenchstream', shouldCache: r => r.length > 0 }
  );
}

// ── Repli API (découvert dans l'APK Onyx : fetchFsMovixBackup) ────────────────
// Movix expose les lecteurs FrenchStream keyés par tmdbId :
//   GET {movixApi}/api/fstream/movie/{tmdbId}
//   GET {movixApi}/api/fstream/tv/{tmdbId}/season/{season}   -> episodes{"N":{languages}}
// Réponse : {success, source:"FStream", players|episodes, ...} où chaque entrée est
// {url, type:"embed", quality, player}. Avantage sur le scraping direct : keyé par
// tmdbId (immunisé aux rotations de domaine fsNN.lol et aux erreurs de titre).
// Exige les en-têtes Movix (Referer/Origin), sinon l'API renvoie {error}.
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

/** Normalise un libellé de langue de l'API (VF/VFF/VFQ/VOSTFR/VO). */
function normalizeApiLang(k: string): string {
  const u = (k || '').toUpperCase();
  if (u.includes('VOSTFR') || u.includes('VOST')) return 'VOSTFR';
  if (u === 'VO' || u.includes('ORIGINAL')) return 'VO';
  // "Default" = piste par défaut du site (français) ; VFF/VFQ = variantes FR.
  if (u.startsWith('VF') || u === 'FRENCH' || u === 'DEFAULT') return 'VF';
  return u || 'VF';
}

/** Lecteurs FrenchStream via l'API Movix. [] si indisponible. */
async function fetchEmbedsFromApi(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<{ url: string; server: string; language: string; forced?: ExtractorId }[]> {
  const { api, referer, origin } = movixApiConfig();
  const url = mediaType === 'series'
    ? `${api}/api/fstream/tv/${tmdbId}/season/${season}`
    : `${api}/api/fstream/movie/${tmdbId}`;
  try {
    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Accept: 'application/json', Referer: referer, Origin: origin },
      timeout: 12000,
    });
    if (!data?.success) return [];

    // Films : players{LANG:[...]}. Séries : episodes{"N":{languages:{LANG:[...]}}}.
    let byLang: Record<string, any[]> | undefined;
    if (mediaType === 'series') {
      const ep = data?.episodes?.[String(episode)];
      byLang = ep?.languages;
    } else {
      byLang = data?.players;
    }
    if (!byLang || typeof byLang !== 'object') return [];

    // "Default" duplique souvent VFF/VFQ : on dédoublonne par URL (première langue
    // rencontrée gagne, en traitant les clés explicites avant "Default").
    const entries = Object.entries(byLang).sort(
      ([a], [b]) => (a.toUpperCase() === 'DEFAULT' ? 1 : 0) - (b.toUpperCase() === 'DEFAULT' ? 1 : 0)
    );
    const out: { url: string; server: string; language: string; forced?: ExtractorId }[] = [];
    const seenUrl = new Set<string>();
    for (const [lang, list] of entries) {
      if (!Array.isArray(list)) continue;
      for (const p of list) {
        if (!p?.url || typeof p.url !== 'string' || seenUrl.has(p.url)) continue;
        seenUrl.add(p.url);
        const server = String(p.player || '').toLowerCase() || 'api';
        out.push({ url: p.url, server, language: normalizeApiLang(lang), forced: forcedFor(server) });
      }
    }
    return out;
  } catch (e: any) {
    console.log(`[FrenchStream] API fallback failed: ${(e.message || '').slice(0, 90)}`);
    return [];
  }
}

async function fetchFrenchStreamStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  apiKey: string,
  extractorConfig: ExtractorConfig,
  season?: number,
  episode?: number
): Promise<FrenchStreamStream[]> {
  console.log(`[FrenchStream] Searching for TMDB ${tmdbId} (${mediaType}${season ? ` S${season}E${episode}` : ''})...`);

  try {
    // TMDB in fr-FR — share the same cache scope/key as Flemmix.
    const tmdbEndpoint = mediaType === 'series' ? 'tv' : 'movie';
    const tmdbData = await cached<any>(
      `tmdb:${tmdbEndpoint}-fr:${tmdbId}`,
      TMDB_TTL_MS,
      async () => {
        const { data } = await axios.get(
          `https://api.themoviedb.org/3/${tmdbEndpoint}/${tmdbId}?api_key=${apiKey}&language=fr-FR`,
          { timeout: 10000 }
        );
        return data;
      },
      { scope: 'tmdb', shouldCache: r => !!r }
    );

    const frTitle: string = tmdbData?.title || tmdbData?.name || tmdbData?.original_title || tmdbData?.original_name;
    const origTitle: string = tmdbData?.original_title || tmdbData?.original_name || '';
    const year = (tmdbData?.release_date || tmdbData?.first_air_date || '').split('-')[0];
    if (!frTitle) return [];

    console.log(`[FrenchStream] TMDB: ${frTitle}${year ? ` (${year})` : ''} / orig: ${origTitle}`);

    // ── 1) API Movix d'abord : keyée par tmdbId, donc pas de résolution de
    //    domaine, pas de recherche, pas de correspondance de titre à rater.
    //    (endpoint découvert dans l'APK Onyx : fetchFsMovixBackup)
    let rawEmbeds: { url: string; server: string; language: string; forced?: ExtractorId }[] =
      await fetchEmbedsFromApi(tmdbId, mediaType, season, episode);
    if (rawEmbeds.length > 0) {
      console.log(`[FrenchStream] API: ${rawEmbeds.length} lecteur(s) pour TMDB ${tmdbId}`);
    } else {
      // ── 2) Filet : scraping du site (si l'API Movix est HS ou n'a pas le titre)
      console.log('[FrenchStream] API sans résultat — repli sur le scraping du site');
      const base = await currentBase();
      let results = await search(base, frTitle);
      // Le domaine a pu tourner depuis la dernière résolution : on retente une fois.
      if (results.length === 0) {
        const fresh = await currentBase(true);
        if (fresh !== base) results = await search(fresh, frTitle);
      }
      if (results.length === 0) {
        console.log('[FrenchStream] No search results');
        return [];
      }

      const liveBase = await currentBase();
      const normFr = normalize(frTitle.replace(/\s*-\s*saison\s+\d+/i, ''));
      const normOrig = origTitle ? normalize(origTitle) : '';

      // On retire "(YYYY)" et "- Saison N" du titre avant la comparaison floue.
      const ranked = results
        .map(r => {
          const cleanTitle = normalize(r.title.replace(/\(\d{4}\)/, '').replace(/\s*-\s*saison\s+\d+.*/i, ''));
          const sim = Math.max(jaccard(normFr, cleanTitle), normOrig ? jaccard(normOrig, cleanTitle) : 0);
          return { r, sim };
        })
        .filter(({ r, sim }) => {
          if (sim < 0.7) return false;
          if (mediaType === 'series') return r.season === season;
          // Films : si les deux années sont connues, exiger l'égalité.
          if (year && r.year) return r.year === year;
          return true;
        })
        .sort((a, b) => b.sim - a.sim);

      if (ranked.length === 0) {
        console.log(`[FrenchStream] No match above threshold${mediaType === 'series' ? ` for S${season}` : ''}`);
        return [];
      }

      const best = ranked[0].r;
      console.log(`[FrenchStream] Match: ${best.title} (id=${best.newsId}, ${(ranked[0].sim * 100).toFixed(0)}%)`);
      rawEmbeds = mediaType === 'series'
        ? await fetchEpisodeEmbeds(liveBase, best.newsId, episode!)
        : await fetchMovieEmbeds(liveBase, best.newsId, tmdbId);

      if (rawEmbeds.length === 0) {
        console.log('[FrenchStream] No embeds found');
        return [];
      }
    }

    // Resolve redirect wrappers (kakaflix -> voe, kokoflix -> filemoon) so the
    // real host passes the extractor filter below.
    const embeds = await Promise.all(rawEmbeds.map(async e => {
      if (isWrapper(e.url)) {
        const resolved = await resolveWrapper(e.url);
        return { ...e, url: resolved };
      }
      return e;
    }));

    // Keep embeds we can resolve: either the domain is recognised, or the
    // provider name told us the host type (forced).
    const supported = embeds.filter(e => {
      if (e.forced) return true;
      try { return detectExtractor(e.url) !== null; } catch { return false; }
    });
    console.log(`[FrenchStream] ${embeds.length} embeds, ${supported.length} supported: ${supported.map(e => e.server).join(', ')}`);

    for (const e of embeds.filter(e => !supported.includes(e))) {
      let host = e.url;
      try { host = new URL(e.url).hostname; } catch { /* keep raw */ }
      console.log(`[FrenchStream] Unrecognized host: ${host} (server="${e.server}", title="${frTitle}")`);
    }

    // Dedupe per (server+language) before extraction; keep VOSTFR/VO too. Cap at 12.
    const seen = new Set<string>();
    const deduped = supported
      .filter(e => {
        const k = `${e.server}:${e.language}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 12);

    const extracted = await Promise.all(
      deduped.map(async embed => {
        const r = await extractStream(embed.url, extractorConfig, embed.forced);
        if (!r) {
          console.log(`[FrenchStream] Extraction failed for ${embed.server} (${embed.url})`);
          return null;
        }
        console.log(`[FrenchStream] Extracted ${embed.server}: ${r.format}`);
        return { embed, r };
      })
    );

    const streams: FrenchStreamStream[] = [];
    for (const item of extracted) {
      if (!item) continue;
      streams.push({
        name: 'FrenchStream',
        title: frTitle.replace(/\(\d{4}\)/, '').trim(),
        url: item.r.url,
        quality: item.r.quality || 'HD',
        language: item.embed.language,
        server: item.embed.server.toLowerCase(),
        headers: item.r.headers,
      });
    }

    console.log(`[FrenchStream] Returning ${streams.length} stream(s)`);
    return streams;
  } catch (e: any) {
    console.log('[FrenchStream] Error:', e.message);
    return [];
  }
}

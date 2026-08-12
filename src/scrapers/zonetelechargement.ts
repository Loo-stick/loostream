import axios from 'axios';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { Wanted, accepts } from '../matching';
import { makeEndpointConfig } from '../endpoint-config';

// Zone-Téléchargement (STREAMING) — le gros catalogue FR (WEB-DL 1080p MULTI/TRUEFRENCH).
// On scrape la section « Regarder en Streaming » des fiches (distincte du DDL que gère
// wastream). Chaîne validée :
//   Recherche : engine/ajax/controller.php?mod=filter&q=<titre>&categorie[]=2 -> fiches
//   Fiche     : data-title + « Date de sortie : YYYY » (matching) + section streaming :
//               <div…16px>Lulustream</div> … <a class="btnToLink" href="//zoneurs.net/?url=…">
//   zoneurs   : protecteur anti-bot -> la page (même « bloquée ») CONTIENT le vrai embed ;
//               on prend le 1er lien externe non-zoneurs -> luluvdo.com/… (lulustream)
//   Extract   : nos extracteurs (lulustream -> tnmr HLS 1080p ; embedseek à venir)
// Domaine ROTATIF -> config/zonetelechargement-endpoints.json (hot-reload / admin).
// FILMS pour l'instant (séries = 2e temps).

const siteEndpoints = makeEndpointConfig('zonetelechargement-endpoints.json', 'ZONETELECHARGEMENT_ENDPOINTS_CONFIG', {
  base: 'https://zone-telechargement.org',
});
export const reloadZoneTelechargementEndpoints = siteEndpoints.reload;
export const getZoneTelechargementEndpoints = siteEndpoints.get;

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const MAX_RESULTS = 10;     // fiches ouvertes/vérifiées par titre (après tri par slug)
const MAX_HOSTS = 2;        // liens de streaming résolus par fiche
const MAX_VARIANTS = 5;     // fiches-variantes traitées (versions qualité/langue du même film)

// Tokens de qualité/langue/source à retirer du slug pour isoler le TITRE.
const SLUG_JUNK = new Set([
  'telecharger', 'gratuit', 'film', 'serie', 'series', 'vf', 'vostfr', 'vost', 'multi', 'truefrench', 'french',
  'ultra', 'hd', 'uhd', 'hdlight', 'bluray', 'blu', 'ray', 'web', 'dl', 'webdl', 'webrip', 'hdrip',
  'x264', 'x265', 'h264', 'h265', 'hevc', '720p', '1080p', '2160p', '4k', 'dvdrip', 'bdrip', 'complete',
  'saison', 'integrale', 'complet', 'vosten', 'final', 'finale',
]);

// Saison depuis le slug (« …saison-2… ») ou le data-title (« … Saison 2 … »).
function seasonOf(url: string, title: string): number | null {
  const s = (url.match(/saison[-\s]?(\d+)/i) || title.match(/saison[-\s]?(\d+)/i))?.[1];
  return s ? Number(s) : null;
}

// Retire les décorations de série du titre pour le matching (« The Last of Us - Saison 1
// [COMPLETE] » -> « The Last of Us »).
function stripSeriesDecorations(title: string): string {
  return title
    .replace(/[-–—]?\s*saison\s*\d+.*$/i, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b(int[ée]grale|complete|complet)\b/gi, '')
    .trim();
}

// films=2, series=15, anime=32 (mapping du site). Une série peut être un ANIME (cat 32) :
// on cherche 15 puis 32 en repli. Les animes ZT sont aussi par saison + épisodes.
const CATEGORIES: Record<string, string[]> = { movie: ['2'], series: ['15', '32'] };

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

export interface ZoneTelechargementStream {
  url: string;
  quality: string;
  language: string;   // MULTI | VF | VOSTFR | VO
  server: string;
  headers?: Record<string, string>;
}

function normalize(t: string): string {
  return (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function fetchText(url: string, opts?: { referer?: string; ajax?: boolean }): Promise<string | null> {
  try {
    const headers: Record<string, string> = { ...HEADERS };
    if (opts?.referer) headers['Referer'] = opts.referer;
    if (opts?.ajax) headers['X-Requested-With'] = 'XMLHttpRequest';
    const { data, status } = await axios.get<string>(url, {
      headers, timeout: REQ_TIMEOUT_MS,
      responseType: 'text', transformResponse: v => v,
      validateStatus: () => true, maxRedirects: 5,
    });
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

// Langue déduite du slug/titre de la fiche (MULTI/TRUEFRENCH/VOSTFR).
function langFromText(s: string): string {
  const l = (s || '').toLowerCase();
  if (/multi/.test(l)) return 'MULTI';
  if (/vostfr|vost/.test(l)) return 'VOSTFR';
  if (/truefrench|\bvf\b|\bfrench\b/.test(l)) return 'VF';
  return 'MULTI'; // les WEB-DL zt sont massivement MULTI
}

// Recherche : renvoie les URLs de fiches (/…/NNNNN-slug.html) pour une catégorie donnée.
async function search(base: string, title: string, cat: string): Promise<string[]> {
  const q = encodeURIComponent(title);
  const url = `${base}/engine/ajax/controller.php?mod=filter&catid=0&q=${q}&categorie%5B%5D=${cat}&art=0&AiffchageMode=0&inputTirePar=0&cstart=0`;
  const html = await fetchText(url, { referer: `${base}/`, ajax: true });
  if (!html) return [];
  const urls: string[] = [];
  for (const m of html.matchAll(/href="([^"]+\/\d+-[^"]+\.html)"/gi)) {
    let u = m[1].replace(/&amp;/g, '&');
    if (u.startsWith('//')) u = 'https:' + u;
    else if (u.startsWith('/')) u = base + u;
    if (/^https?:\/\//.test(u)) urls.push(u);
  }
  return [...new Set(urls)];
}

// Tokens « titre » d'une URL de fiche (slug sans l'id, ni les tags qualité/langue/source).
function slugTitleTokens(url: string): string[] {
  const slug = (url.split('/').pop() || '').replace(/\.html$/i, '').replace(/^\d+-/, '');
  return slug.split('-').map(t => t.toLowerCase()).filter(t => t && !SLUG_JUNK.has(t) && !/^\d+$/.test(t));
}

// Classe les fiches par proximité au titre voulu : d'abord celles dont le slug contient
// TOUS les tokens voulus, puis par nombre de tokens « en trop » croissant (le titre de
// base « Matrix » passe avant « Matrix Revolutions »).
function rankBySlug(urls: string[], titles: string[]): string[] {
  const wantedTokenLists = titles.map(t => (t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || []));
  const score = (u: string): number => {
    const st = new Set(slugTitleTokens(u));
    let best = 999;
    for (const wt of wantedTokenLists) {
      if (wt.length && wt.every(t => st.has(t))) best = Math.min(best, st.size - wt.length); // tokens « en trop »
    }
    return best;
  };
  return [...urls].map(u => ({ u, s: score(u) })).sort((a, b) => a.s - b.s).map(x => x.u);
}

interface Fiche { title: string; year?: number; slug: string; pairs: { host: string; zoneurs: string }[]; }

// FILM : sous chaque host (font-size:16px), 1 seul lien zoneurs.
function parseMoviePairs(section: string): { host: string; zoneurs: string }[] {
  const pairs: { host: string; zoneurs: string }[] = [];
  // Protecteur domaine-agnostique : n'importe quel `//<domaine>/?url=<token>` (zoneurs.net
  // aujourd'hui, mais résilient si zt change de protecteur).
  for (const m of section.matchAll(/font-size:\s*16px[^>]*>([A-Za-z ]+)<\/div>[\s\S]{0,200}?href="(\/\/[a-z0-9][a-z0-9.-]*\/\?url=[^"]+)"/gi)) {
    pairs.push({ host: m[1].trim(), zoneurs: 'https:' + m[2].replace(/&amp;/g, '&') });
  }
  return pairs;
}

// SÉRIE : sous chaque host, une liste <a href="zoneurs">Episode N</a>. On isole les blocs
// par host (headers font-size:16px) puis on garde le lien de l'épisode demandé.
function parseEpisodePairs(section: string, episode: number): { host: string; zoneurs: string }[] {
  const pairs: { host: string; zoneurs: string }[] = [];
  const hostRx = /font-size:\s*16px[^>]*>([A-Za-z ]+)<\/div>/gi;
  const hosts: { name: string; start: number }[] = [];
  let hm: RegExpExecArray | null;
  while ((hm = hostRx.exec(section))) hosts.push({ name: hm[1].trim(), start: hm.index });
  for (let h = 0; h < hosts.length; h++) {
    const block = section.slice(hosts[h].start, h + 1 < hosts.length ? hosts[h + 1].start : section.length);
    for (const em of block.matchAll(/href="(\/\/[a-z0-9][a-z0-9.-]*\/\?url=[^"]+)"[^>]*>\s*Episode\s*(\d+)/gi)) {
      if (Number(em[2]) === episode) {
        pairs.push({ host: hosts[h].name, zoneurs: 'https:' + em[1].replace(/&amp;/g, '&') });
      }
    }
  }
  return pairs;
}

// Fiche : identité (data-title + Date de sortie) + pairs streaming. `episode` défini => série.
function parseFiche(html: string, url: string, episode?: number): Fiche | null {
  const title = html.match(/data-title="([^"]+)"/i)?.[1];
  if (!title) return null;
  const year = html.match(/Date de sortie\s*:?\s*(\d{4})-\d{2}-\d{2}/i)?.[1];
  const i = html.indexOf('Regarder en Streaming');
  // Les sections séries sont plus longues (beaucoup d'épisodes) -> fenêtre large.
  const section = i >= 0 ? html.slice(i, i + (episode != null ? 20000 : 4000)) : '';
  const pairs = section ? (episode != null ? parseEpisodePairs(section, episode) : parseMoviePairs(section)) : [];
  return { title, year: year ? Number(year) : undefined, slug: url, pairs };
}

// « Qualités également disponibles pour ce film » : chaque version (DVDRIP, Blu-Ray,
// VOSTFR, x265…) est une FICHE séparée avec sa propre section streaming. On récupère ces
// URLs pour offrir toutes les variantes (choix qualité/langue).
function extractVariantUrls(html: string, base: string): string[] {
  const i = html.search(/disponibles?\s+pour\s+ce/i);
  if (i < 0) return [];
  const section = html.slice(i, i + 3500);
  const urls: string[] = [];
  for (const m of section.matchAll(/href="([^"]+\/\d+-telecharger[^"]+\.html)"/gi)) {
    let u = m[1].replace(/&amp;/g, '&');
    if (u.startsWith('//')) u = 'https:' + u;
    else if (u.startsWith('/')) u = base + u;
    if (/^https?:\/\//.test(u)) urls.push(u);
  }
  return [...new Set(urls)];
}

// zoneurs (protecteur) : la page contient le vrai embed -> 1er lien externe non-zoneurs
// reconnu par nos extracteurs (ou, à défaut, le 1er lien externe « propre »).
async function resolveZoneurs(zoneursUrl: string, referer: string): Promise<string | null> {
  const html = await fetchText(zoneursUrl, { referer });
  if (!html) return null;
  // Domaine du protecteur déduit de l'URL (zoneurs.net ou autre) -> exclu des candidats.
  let protector = 'zoneurs';
  try { protector = new URL(zoneursUrl).hostname.replace(/^www\./, '').split('.')[0]; } catch { /* défaut */ }
  const junk = new RegExp(`${protector}|/assets/|googleapis|gstatic|yandex|schema\\.org|w3\\.org|jquery|fonts?\\.`, 'i');
  const candidates: string[] = [];
  for (const m of html.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\/[a-zA-Z0-9/_#-]+/gi)) {
    if (junk.test(m[0])) continue;
    candidates.push(m[0]);
  }
  return candidates.find(u => detectExtractor(u)) || candidates[0] || null;
}

export async function getZoneTelechargementStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle?: string,
  year?: number,
  season?: number,
  episode?: number
): Promise<ZoneTelechargementStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const titles = [...new Set([title, originalTitle].filter(Boolean) as string[])];
  const key = mediaType === 'series'
    ? `ztstream:${mode}:series:${normalize(title)}:${season}:${episode}`
    : `ztstream:${mode}:movie:${normalize(title)}`;
  return cached(
    key, STREAMS_TTL_MS,
    async () => { const s = await fetchStreams(mediaType, titles, year, extractorConfig, season, episode); return applyMultiAudio(s); },
    { scope: 'ztstream', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchStreams(
  mediaType: 'movie' | 'series', titles: string[], year: number | undefined,
  extractorConfig: ExtractorConfig, season?: number, episode?: number
): Promise<ZoneTelechargementStream[]> {
  const base = getZoneTelechargementEndpoints().base.replace(/\/$/, '');
  const isSeries = mediaType === 'series';
  const contentType = isSeries ? 'series' : 'movie';

  // Cherche dans les catégories du type (série -> 15 séries puis 32 anime), titre FR d'abord.
  let results: string[] = [];
  outer: for (const cat of CATEGORIES[contentType] || []) {
    for (const t of titles) { results = await search(base, t, cat); if (results.length) break outer; }
  }
  if (!results.length) { console.log(`[ZT-Stream] aucun résultat pour "${titles[0]}"`); return []; }

  // Série : matching titre (décorations « Saison N » retirées) + SAISON, sans année (elle
  // varie selon la saison). Film : titre token-set + année.
  const wanted: Wanted = { titles, year: isSeries ? undefined : year };
  const accept = (f: Fiche): boolean => {
    if (isSeries) {
      if (seasonOf(f.slug, f.title) !== season) return false;
      return accepts(wanted, { title: stripSeriesDecorations(f.title), year: undefined, item: f });
    }
    return accepts(wanted, { title: f.title, year: f.year, item: f });
  };
  const parse = (html: string, url: string): Fiche | null => parseFiche(html, url, isSeries ? episode : undefined);

  // La recherche renvoie DÉJÀ toutes les versions (qualité/langue, et par saison en série).
  // On garde toutes les fiches qui matchent = les variantes ; on complète avec les
  // cross-links « également disponibles » de la 1re (belt-and-suspenders).
  const fiches: (Fiche | null)[] = [];
  const fetched = new Set<string>();
  let crossLinks: string[] = [];
  for (const url of rankBySlug(results, titles).slice(0, MAX_RESULTS)) {
    if (fiches.filter(Boolean).length >= MAX_VARIANTS) break;
    if (fetched.has(url)) continue;
    fetched.add(url);
    const html = await fetchText(url, { referer: `${base}/` });
    if (!html) continue;
    const f = parse(html, url);
    if (!f || !f.pairs.length || !accept(f)) continue;
    fiches.push(f);
    if (!crossLinks.length) crossLinks = extractVariantUrls(html, base);
  }
  // Complète avec les cross-links pas encore vus (autres langues/qualités de la même saison).
  for (const url of crossLinks) {
    if (fiches.filter(Boolean).length >= MAX_VARIANTS) break;
    if (fetched.has(url)) continue;
    fetched.add(url);
    const html = await fetchText(url, { referer: `${base}/` });
    if (!html) continue;
    const f = parse(html, url);
    if (f && f.pairs.length && (!isSeries || seasonOf(f.slug, f.title) === season)) fiches.push(f);
  }
  if (!fiches.filter(Boolean).length) { console.log(`[ZT-Stream] pas de fiche correspondante pour "${titles[0]}"`); return []; }

  // Résout + extrait tous les hosts de toutes les variantes (langue = slug de la variante).
  const tasks: Promise<ZoneTelechargementStream | null>[] = [];
  for (const f of fiches) {
    if (!f || !f.pairs.length) continue;
    const lang = langFromText(f.slug);
    for (const p of f.pairs.slice(0, MAX_HOSTS)) {
      tasks.push((async () => {
        const embed = await resolveZoneurs(p.zoneurs, f.slug);
        if (!embed) return null;
        const r = await extractStream(embed, extractorConfig);
        if (!r?.url) return null;
        return {
          url: r.url, quality: r.quality || 'HD', language: lang,
          server: p.host.toLowerCase().replace(/\s+/g, ''), headers: r.headers,
        };
      })());
    }
  }
  const resolved = await Promise.all(tasks);

  // Dédup : par URL (même fichier) ET par (qualité|langue|host) — 3 fiches MULTI 720p
  // sur le même host lulustream = 1 entrée utile ; on garde la variété qualité/langue et,
  // à terme, le fallback multi-host (lulustream vs embedseek au même palier).
  const seenUrl = new Set<string>();
  const seenCombo = new Set<string>();
  const streams: ZoneTelechargementStream[] = [];
  for (const s of resolved) {
    if (!s || seenUrl.has(s.url)) continue;
    const combo = `${s.quality}|${s.language}|${s.server}`;
    if (seenCombo.has(combo)) continue;
    seenUrl.add(s.url); seenCombo.add(combo); streams.push(s);
  }
  console.log(`[ZT-Stream] ${streams.length} flux (${[...new Set(streams.map(s => s.language))].join('/')}) pour "${titles[0]}"`);
  return streams;
}

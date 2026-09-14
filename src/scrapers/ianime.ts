// IAnime (www.ianimes.eu) — anime FR, VF ET VOSTFR. Repéré dans Onyx v1.7.250.
// Complète nos sources anime (VoirAnime/AnimeSama/Vostfree), notamment sur la VF.
//
// Chaîne (reverse depuis Onyx) :
//   1. recherche : POST /result.php  (corps `s=<requête>`) -> fiches
//      <a href="liste.php?manga=<slug>" title="<TITRE>">, le slug portant la langue
//      (…-vf / …-vostfr).
//   2. page anime : GET /liste.php?manga=<slug> -> liens d'épisodes
//      <slug>-ep<N>-<lang>.htm.
//   3. page épisode : plusieurs iframes de lecteurs (vidmoly, voe, streamtape,
//      mail.ru…) — hôtes que nos extracteurs gèrent déjà.

import axios from 'axios';
import { extractStream, detectExtractor, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { makeEndpointConfig } from '../endpoint-config';
import { titlesMatch, expandTitles } from '../matching';

const endpoints = makeEndpointConfig('ianime-endpoints.json', 'IANIME_ENDPOINTS_CONFIG', {
  base: 'https://www.ianimes.eu',
});
export const getIanimeEndpoints = endpoints.get;
export const reloadIanimeEndpoints = endpoints.reload;

const BASE = () => String(endpoints.get().base).replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const STREAMS_TTL_MS = 3 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 30 * 60 * 1000;
const MAX_EXTRACTIONS = 5;

function headers(): Record<string, string> {
  return { 'User-Agent': UA, Referer: `${BASE()}/`, 'Accept-Language': 'fr-FR,fr;q=0.9' };
}

async function getHtml(url: string): Promise<string | null> {
  try {
    const { data, status } = await axios.get<string>(url, {
      headers: headers(), timeout: 12000, responseType: 'text', transformResponse: v => v,
      validateStatus: s => s < 500, maxContentLength: 8 * 1024 * 1024,
    });
    return status === 200 && typeof data === 'string' ? data : null;
  } catch {
    return null;
  }
}

// ── Recherche ────────────────────────────────────────────────────────────────

interface Fiche { slug: string; title: string; language: string }

// Leur moteur CASSE dès qu'un mot supplémentaire tombe sur une ponctuation du titre
// stocké (« boruto » -> 8 résultats, « boruto naruto » -> 0, car stocké « BORUTO: NARUTO »).
// On interroge donc avec le PREMIER MOT SIGNIFICATIF (on saute les articles), puis le
// rapprochement strict sur les titres RENVOYÉS assure la précision.
const STOP = new Set(['the', 'le', 'la', 'les', 'un', 'une', 'des', 'no', 'to', 'of', 'a']);
function normQuery(s: string): string {
  const toks = (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const first = toks.find(t => t.length >= 3 && !STOP.has(t)) || toks[0] || '';
  return first;
}

function langFromSlug(slug: string): string {
  return /-vf(\b|$|-)/i.test(slug) ? 'VF' : 'VOSTFR'; // défaut VOSTFR (sous-titré)
}

async function search(query: string): Promise<Fiche[]> {
  const q = normQuery(query);
  if (!q) return [];
  return cached<Fiche[]>(
    `ianime:search:${q}`, STREAMS_TTL_MS,
    async () => {
      let html: string | null = null;
      try {
        const { data, status } = await axios.post<string>(`${BASE()}/result.php`, `s=${encodeURIComponent(q)}`, {
          headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 12000, responseType: 'text', transformResponse: v => v, validateStatus: s => s < 500,
        });
        if (status === 200 && typeof data === 'string') html = data;
      } catch { /* réseau : rien */ }
      if (!html) return [];
      const fiches = new Map<string, Fiche>();
      // <a href="liste.php?manga=<slug>" title="<TITRE>">
      for (const m of html.matchAll(/href="[^"]*liste\.php\?manga=([^"&]+)"[^>]*\btitle="([^"]+)"/gi)) {
        const slug = m[1];
        if (fiches.has(slug)) continue;
        fiches.set(slug, { slug, title: m[2].trim(), language: langFromSlug(slug) });
      }
      return [...fiches.values()];
    },
    { scope: 'ianime', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

// ── Épisode ──────────────────────────────────────────────────────────────────

/** URL de la page d'un épisode donné dans la fiche, ou '' si absent. */
async function episodePage(slug: string, episode: number | undefined): Promise<string> {
  const html = await getHtml(`${BASE()}/liste.php?manga=${encodeURIComponent(slug)}`);
  if (!html) return '';
  const links = [...html.matchAll(/href="([^"]+\.htm)"/gi)].map(m => m[1]);
  if (links.length === 0) return '';
  const abs = (u: string) => (/^https?:\/\//.test(u) ? u : `${BASE()}/${u.replace(/^\.?\//, '')}`);
  // Film (pas d'épisode) : la 1re page listée.
  if (episode === undefined) return abs(links[0]);
  // Série : le lien dont le numéro d'épisode correspond (…-ep<N>-…). On borne le
  // nombre pour ne pas confondre « ep1 » avec « ep10/11… » (\b après le chiffre).
  const wanted = links.find(u => new RegExp(`[-_]ep${episode}(?![0-9])`, 'i').test(u));
  return wanted ? abs(wanted) : '';
}

interface Embed { url: string; server: string }

function serverOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return 'lecteur'; }
}

/** Iframes de lecteurs d'une page d'épisode. */
async function embedsOf(episodeUrl: string): Promise<Embed[]> {
  const html = await getHtml(episodeUrl);
  if (!html) return [];
  const out = new Map<string, Embed>();
  for (const m of html.matchAll(/<iframe[^>]+src="([^"]+)"/gi)) {
    const url = m[1].replace(/&amp;/g, '&');
    if (/^https?:\/\//.test(url) && !out.has(url)) out.set(url, { url, server: serverOf(url) });
  }
  return [...out.values()];
}

export interface IanimeStream {
  url: string;
  quality: string;
  language: string;
  server: string;
  headers?: Record<string, string>;
}

async function extractAll(embeds: Embed[], language: string, extractorConfig: ExtractorConfig): Promise<IanimeStream[]> {
  const supported = embeds.filter(e => { try { return detectExtractor(e.url) !== null; } catch { return false; } });
  const seen = new Set<string>();
  const deduped = supported.filter(e => { if (seen.has(e.server)) return false; seen.add(e.server); return true; }).slice(0, MAX_EXTRACTIONS);
  const results = await Promise.all(deduped.map(async e => {
    try {
      const r = await extractStream(e.url, extractorConfig);
      if (!r?.url) return null;
      return { url: r.url, quality: r.quality || 'HD', language, server: e.server, headers: r.headers } as IanimeStream;
    } catch { return null; }
  }));
  return results.filter((x): x is IanimeStream => x !== null);
}

// ── Point d'entrée ─────────────────────────────────────────────────────────────

export async function getIanimeStreams(
  id: string,
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  season: number | undefined,
  episode: number | undefined,
  title: string,
  originalTitle?: string,
  altTitles: string[] = [],
): Promise<IanimeStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && !episode) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = mediaType === 'series'
    ? `ianime:${mode}:series:${id}:${season || 1}:${episode}`
    : `ianime:${mode}:movie:${id}`;
  const titles = [...new Set([...altTitles, originalTitle, title].filter(Boolean) as string[])];
  return cached(
    key, STREAMS_TTL_MS,
    async () => { const s = await fetchIanime(mediaType, titles, episode, extractorConfig); return applyMultiAudio(s); },
    { scope: 'ianime', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchIanime(
  mediaType: 'movie' | 'series', titles: string[], episode: number | undefined, extractorConfig: ExtractorConfig,
): Promise<IanimeStream[]> {
  const wanted = expandTitles(titles);
  // Une recherche par titre distinct (romaji/original/affiché) jusqu'à un résultat.
  const fiches = new Map<string, Fiche>();
  for (const t of titles.slice(0, 3)) {
    for (const f of await search(t).catch(() => [] as Fiche[])) {
      // Correspondance stricte sur le titre de la fiche (token-set exact).
      if (titlesMatch(wanted, f.title) && !fiches.has(f.slug)) fiches.set(f.slug, f);
    }
    if (fiches.size > 0) break;
  }
  if (fiches.size === 0) return [];

  const ep = mediaType === 'series' ? episode : undefined;
  // On sert VF et VOSTFR si les deux fiches ont l'épisode.
  const groups = await Promise.all([...fiches.values()].map(async f => {
    const page = await episodePage(f.slug, ep);
    if (!page) return [] as IanimeStream[];
    const embeds = await embedsOf(page);
    if (embeds.length === 0) return [] as IanimeStream[];
    console.log(`[IAnime] ${f.language} (${f.slug}): ${embeds.length} lecteur(s)`);
    return extractAll(embeds, f.language, extractorConfig);
  }));
  const streams = groups.flat();
  console.log(`[IAnime] Returning ${streams.length} stream(s) pour "${titles[0]}"`);
  return streams;
}

/** Santé : la recherche répond et rend au moins une fiche. */
export async function ianimeProbe(): Promise<boolean> {
  return (await search('naruto')).length > 0;
}

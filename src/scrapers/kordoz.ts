import axios from 'axios';
import { extractStream, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { applyMultiAudio } from '../multiaudio';
import { Wanted, accepts, yearVerdict } from '../matching';
import { probeHlsResolution } from '../hls-resolution';
import { makeEndpointConfig } from '../endpoint-config';

// Kordoz — catalogue FILMS FR (kordoz.com), VF ET VOSTFR (versions séparées).
// FILMS UNIQUEMENT : les catégories du site sont toutes ciné (Action, Drame,
// Horreur, SF…), il n'y a AUCUNE section « Séries » (Breaking Bad/Lupin absents) ->
// on renvoie [] en série.
//
// Accès : Cloudflare + une gate applicative -> deux prérequis pour toute page utile :
//   • Cookie `g=true` (statique — consentement/anti-bot ; sans lui : réponse vide).
//   • Un TOKEN DE SESSION dans le chemin : la racine `/` expose `<a href="<token>">`
//     (~11 alphanum), et toutes les routes sont préfixées `/<token>/…`.
// Flux :
//   Recherche : POST `/<token>/home/kordoz`  body `searchword=<titre>`
//               -> <a class="film-card" href="/<token>/b/kordoz/<id>">…alt="<titre>"
//               (PAS d'année dans les résultats -> on la vérifie sur la fiche)
//   Fiche     : GET  `/<token>/b/<slug>/<id>`
//               -> <iframe src="https://sharecloudy.com/iframe/<x>">  (1 hôte)
//               + année dans <title><Slug> - <titre> (YYYY)
//   Player    : sharecloudy -> (302) ofbax -> jwplayer `file: …m3u8` (directable) ;
//               géré tel quel par extractSharecloudy (aucun code hôte à écrire).
//
// MIROIRS : le même backend (catalogue + flux sharecloudy IDENTIQUES, seuls les ids
// internes diffèrent) est servi sous plusieurs domaines qui se font blacklister à tour
// de rôle (kordoz.com, ilmiv.com, kidraz.com, vogfo.com…). On les essaie dans l'ordre
// pour la résilience. Le `slug` d'URL = le nom de domaine de 2e niveau (kordoz.com ->
// "kordoz"). La liste est éditable À CHAUD (config/kordoz-endpoints.json, bind-monté +
// hot-reload) ou via l'admin — pas de rebuild quand un miroir tombe / un nouveau sort.
const siteEndpoints = makeEndpointConfig('kordoz-endpoints.json', 'KORDOZ_ENDPOINTS_CONFIG', {
  domains: ['https://www.kordoz.com', 'https://ilmiv.com', 'https://www.kidraz.com', 'https://vogfo.com'],
});
export const reloadKordozEndpoints = siteEndpoints.reload;
export const getKordozEndpoints = siteEndpoints.get;

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const MAX_CANDIDATES = 3;   // fiches ouvertes par requête (après matching titre)

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Cookie': 'g=true',
};

export interface KordozStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR | VO | MULTI
  server: string;
  headers?: Record<string, string>;
}

function normalize(t: string): string {
  return (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// slug d'URL = nom de domaine de 2e niveau (www.kordoz.com -> "kordoz").
function slugOf(base: string): string {
  try { return new URL(base).hostname.replace(/^www\./, '').split('.')[0]; } catch { return 'kordoz'; }
}

async function fetchText(url: string, base: string, postBody?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = postBody
      ? { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${base}/` }
      : HEADERS;
    const cfg = {
      headers, timeout: REQ_TIMEOUT_MS,
      responseType: 'text' as const, transformResponse: (v: any) => v,
      validateStatus: () => true, maxRedirects: 4,
    };
    const { data, status } = postBody
      ? await axios.post<string>(url, postBody, cfg)
      : await axios.get<string>(url, cfg);
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

// Le token de session est le seul <a href="…"> à valeur purement alphanumérique
// (les autres portent un point/slash : favicon.png, /…). Caché par domaine : il ne
// tourne pas souvent, mais on le relit périodiquement au cas où.
async function getSessionToken(base: string): Promise<string | null> {
  return cached<string | null>(
    `kordoz:token:${base}`, TOKEN_TTL_MS,
    async () => {
      const html = await fetchText(`${base}/`, base);
      if (!html) return null;
      return html.match(/href="([a-z0-9]{8,})"/i)?.[1] || null;
    },
    { scope: 'kordoz', shouldCache: r => !!r }
  );
}

interface SearchItem { id: string; title: string; }

async function search(base: string, token: string, slug: string, title: string): Promise<SearchItem[]> {
  const html = await fetchText(`${base}/${token}/home/${slug}`, base, `searchword=${encodeURIComponent(title)}`);
  if (!html) return [];
  const items: SearchItem[] = [];
  const rx = new RegExp(`<a class="film-card" href="\\/[^"/]+\\/b\\/${slug}\\/(\\d+)"[\\s\\S]{0,240}?alt="([^"]*)"`, 'gi');
  for (const m of html.matchAll(rx)) items.push({ id: m[1], title: m[2] });
  return items;
}

interface Detail { iframe: string; year?: number; language: string; }

// LANGUE : le site N'A PAS de signal de langue fiable. Le badge `film-detail-badge-vostfr`
// est DÉCORATIF (statique) — il est présent, à l'identique, sur TOUTES les fiches, y compris
// des films FRANÇAIS (Intouchables) et des flux réellement VF (Fight Club vérifié par un
// utilisateur : badge « VOSTFR » mais audio VF). Le flux lui-même ne déclare rien (PMT TS =
// « und »). On étiquette donc VF par défaut — les sites FR servent massivement du doublage,
// et c'est le cas vérifié. applyMultiAudio ré-étiquette en MULTI s'il détecte 2+ pistes audio.
async function getDetail(base: string, token: string, slug: string, id: string): Promise<Detail | null> {
  const html = await fetchText(`${base}/${token}/b/${slug}/${id}`, base);
  if (!html) return null;
  const iframe = html.match(/<iframe[^>]*\ssrc="(https?:\/\/[^"]+)"/i)?.[1];
  if (!iframe) return null;
  const year = html.match(/<title>[^<]*\((\d{4})\)/i)?.[1];
  return { iframe, year: year ? Number(year) : undefined, language: 'VF' };
}

function serverName(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h.split('.')[0] || 'sharecloudy';
  } catch { return 'sharecloudy'; }
}

export async function getKordozStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle?: string,
  year?: number
): Promise<KordozStream[]> {
  if (mediaType !== 'movie') return []; // FILMS UNIQUEMENT (aucune section séries sur le site)
  if (!title) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const titles = [...new Set([title, originalTitle].filter(Boolean) as string[])];
  const key = `kordoz:${mode}:movie:${normalize(title)}`;
  return cached(
    key, STREAMS_TTL_MS,
    async () => { const s = await fetchKordozStreams(titles, year, extractorConfig); return applyMultiAudio(s); },
    { scope: 'kordoz', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchKordozStreams(
  titles: string[], year: number | undefined, extractorConfig: ExtractorConfig
): Promise<KordozStream[]> {
  // Premier domaine miroir joignable (token obtenu) -> on y fait tout le flux. Les
  // miroirs servant un catalogue identique, inutile d'essayer les suivants si celui-ci
  // répond : on ne bascule que si un domaine est INJOIGNABLE (token null / recherche KO).
  let base = '', token = '', slug = '', items: SearchItem[] = [];
  for (const b of getKordozEndpoints().domains) {
    const t = await getSessionToken(b);
    if (!t) continue; // domaine down/blacklisté -> miroir suivant
    base = b; token = t; slug = slugOf(b);
    for (const title of titles) { items = await search(base, token, slug, title); if (items.length) break; }
    break; // domaine joignable -> on s'y tient (catalogue identique sur les miroirs)
  }
  if (!base) { console.log('[Kordoz] aucun domaine miroir joignable'); return []; }
  if (!items.length) { console.log(`[Kordoz] aucun résultat pour "${titles[0]}" (${slug})`); return []; }

  // La recherche ne porte pas l'année -> matching STRICT sur le titre (token-set exact,
  // « Deadpool » ne matche pas « Deadpool 2 »), l'année est vérifiée sur la FICHE.
  const wantedTitleOnly: Wanted = { titles };
  const candidates = items
    .filter(it => accepts(wantedTitleOnly, { title: it.title, item: it }))
    .slice(0, MAX_CANDIDATES);
  if (!candidates.length) { console.log(`[Kordoz] pas de correspondance titre pour "${titles[0]}"`); return []; }

  const groups = await Promise.all(candidates.map(async (c): Promise<KordozStream[]> => {
    const detail = await getDetail(base, token, slug, c.id);
    if (!detail) return [];
    // Année contradictoire (remake : « The Invitation » 2015 vs 2022) -> on écarte.
    if (yearVerdict(year, detail.year) === 'mismatch') return [];
    const r = await extractStream(detail.iframe, extractorConfig);
    if (!r?.url) return [];
    // Le manifeste sharecloudy est une playlist média mono-qualité (sans RESOLUTION) : on
    // sonde le 1er segment TS pour (a) écarter les flux MORTS (404 CDN, ex. certains titres)
    // et (b) lire la vraie résolution dans le SPS H.264. Repli sur 'HD' si résolution KO.
    if (/\.m3u8/i.test(r.url)) {
      const probe = await probeHlsResolution(r.url, r.headers || {});
      if (probe.dead) { console.log(`[Kordoz] flux mort (404) écarté pour "${c.title}"`); return []; }
      return [{
        url: r.url, quality: probe.quality || r.quality || 'HD',
        language: detail.language, server: serverName(detail.iframe), headers: r.headers,
      }];
    }
    return [{
      url: r.url,
      quality: r.quality || 'HD',
      language: detail.language,
      server: serverName(detail.iframe),
      headers: r.headers,
    }];
  }));

  const streams = groups.flat();
  console.log(`[Kordoz] ${streams.length} flux pour "${titles[0]}"`);
  return streams;
}

import axios from 'axios';
import { extractStream, ExtractorConfig } from '../extractors';
import { cached } from '../cache';
import { Wanted, accepts } from '../matching';
import { probeMp4Resolution } from '../hls-resolution';

// DocStream — catalogue de DOCUMENTAIRES FR (docstream.fr), keyé titre+année.
// MFP UNIQUEMENT : ~99% des fiches sont des embeds STREAMTAPE (554/556), hôte qu'on
// n'extrait PAS en local (anti-bot à leurres randomisés) — seul MediaFlow le résout.
// Sans MediaFlow on ne rend donc rien (dégradation propre, aucun flux offert).
//
// Le catalogue est INLINE dans la home (const CATALOG = [ {id,type,title,desc,category,
// year,duration,stars,embed:"streamtape:<id>",thumb,…}, … ]) : un seul fetch, caché 6h,
// matching local. FILMS uniquement (540 films / 2 séries -> les 2 séries sont ignorées).

const BASE = 'https://docstream.fr';
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const MAX_CANDIDATES = 3;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

export interface DocstreamStream {
  url: string;
  quality: string;
  language: string;
  server: string;
  headers?: Record<string, string>;
}

function normalize(t: string): string {
  return (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

interface CatalogItem { title: string; year?: number; embedId: string; }

async function fetchText(url: string): Promise<string | null> {
  try {
    const { data, status } = await axios.get<string>(url, {
      headers: HEADERS, timeout: REQ_TIMEOUT_MS,
      responseType: 'text', transformResponse: v => v,
      validateStatus: () => true, maxRedirects: 4,
    });
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

// Le CATALOG est un tableau d'objets PLATS (aucun objet imbriqué) -> on isole chaque
// objet `{…}` puis on lit ses champs. Robuste au contenu du champ `desc` (prose FR).
async function getCatalog(): Promise<CatalogItem[]> {
  return cached<CatalogItem[]>(
    'docstream:catalog', CATALOG_TTL_MS,
    async () => {
      const html = await fetchText(`${BASE}/`);
      if (!html) return [];
      const items: CatalogItem[] = [];
      for (const m of html.matchAll(/\{[^{}]*?embed:\s*"streamtape:[^"}]+"[^{}]*\}/gi)) {
        const obj = m[0];
        const title = obj.match(/title:\s*"((?:[^"\\]|\\.)*)"/i)?.[1];
        const embedId = obj.match(/embed:\s*"streamtape:([^"]+)"/i)?.[1];
        if (!title || !embedId) continue;
        const year = obj.match(/year:\s*(\d{4})/i)?.[1];
        items.push({ title: title.trim(), year: year ? Number(year) : undefined, embedId });
      }
      return items;
    },
    { scope: 'docstream', shouldCache: r => r.length > 0 }
  );
}

export async function getDocstreamStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle?: string,
  year?: number
): Promise<DocstreamStream[]> {
  if (mediaType !== 'movie') return []; // FILMS uniquement (2 séries du catalogue ignorées)
  if (!title) return [];
  // MFP-ONLY : sans MediaFlow, streamtape n'est pas résoluble -> on n'appelle même pas.
  if (!extractorConfig.useMediaFlow || !extractorConfig.mediaFlowUrl) return [];
  const titles = [...new Set([title, originalTitle].filter(Boolean) as string[])];
  const key = `docstream:mf:movie:${normalize(title)}`;
  return cached(
    key, STREAMS_TTL_MS,
    async () => fetchDocstreamStreams(titles, year, extractorConfig),
    { scope: 'docstream', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchDocstreamStreams(
  titles: string[], year: number | undefined, extractorConfig: ExtractorConfig
): Promise<DocstreamStream[]> {
  const catalog = await getCatalog();
  if (!catalog.length) { console.log('[Docstream] catalogue vide'); return []; }

  // Matching STRICT titre (token-set exact) + année non contradictoire.
  const wanted: Wanted = { titles, year };
  const matches = catalog
    .filter(it => accepts(wanted, { title: it.title, year: it.year, item: it }))
    .slice(0, MAX_CANDIDATES);
  if (!matches.length) { console.log(`[Docstream] pas de correspondance pour "${titles[0]}"`); return []; }

  const streams = await Promise.all(matches.map(async (it): Promise<DocstreamStream | null> => {
    const r = await extractStream(`https://streamtape.com/e/${it.embedId}/`, extractorConfig);
    if (!r?.url) return null; // MediaFlow n'a pas résolu (streamtape mort / KO) -> on écarte
    // MediaFlow renvoie 'HD' en dur : on lit la vraie résolution dans l'en-tête MP4
    // (box avc1) de l'URL résolue. Repli sur 'HD' si l'en-tête n'est pas lisible.
    const probed = await probeMp4Resolution(r.url, r.headers || {});
    return {
      url: r.url,
      quality: probed || r.quality || 'HD',
      language: 'VF', // docs FR-curatés (Panthère des neiges…) ; pas de signal fiable -> défaut VF
      server: 'streamtape',
      headers: r.headers,
    };
  }));

  const out = streams.filter((x): x is DocstreamStream => x !== null);
  console.log(`[Docstream] ${out.length} flux pour "${titles[0]}"`);
  return out;
}

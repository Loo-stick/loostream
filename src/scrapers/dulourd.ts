import axios from 'axios';
import { extractStream, ExtractorConfig, ExtractorId } from '../extractors';
import { makeDnsSafeAgent } from '../dns-resolve';
import { cached } from '../cache';
import { Wanted, accepts } from '../matching';
import { probeHlsResolution } from '../hls-resolution';
import { makeEndpointConfig } from '../endpoint-config';

// dulourd (www.dulourd.boo) — catalogue SÉRIES FR, VF + VOSTFR, moteur DataLife
// Engine (même famille que Zone-Téléchargement). SÉRIES UNIQUEMENT : le site n'a
// aucune section film -> on renvoie [] pour un film.
//
// Protocole (reversé le 2026-09-07) :
//   1. Recherche DLE : GET index.php?do=search&subaction=search&story=<titre>
//      -> <a href="…/voir-series/<cat>/<id>-<slug>.html"> + alt="<Titre (année)>"
//   2. L'URL d'un épisode se CONSTRUIT (pas de navigation à faire) :
//      <fiche sans .html>/<saison>-saison/<episode>-episode.html
//   3. Cette page porte un bouton par lecteur :
//      onclick="playEpisode(this, '759', 'voe_vf')"   <- id d'épisode + hôte + LANGUE
//   4. L'embed s'obtient par un POST (fonction playEpisode du bundle DLE) :
//      POST /engine/inc/serial/app/ajax/Season.php
//           id=<id>&xfield=<hote>_<vf|vostfr>&action=playEpisode
//      -> HTML contenant <iframe src="<embed>">
//
// ⚠️ Le REFERER (la page épisode) est exigé par le POST.
// Le domaine est bloqué en DNS par le FAI de l'hébergeur -> agent partagé.

const siteEndpoints = makeEndpointConfig('dulourd-endpoints.json', 'DULOURD_ENDPOINTS_CONFIG', {
  base: 'https://www.dulourd.boo',
});
export const reloadDulourdEndpoints = siteEndpoints.reload;
export const getDulourdEndpoints = siteEndpoints.get;

const BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
const MAX_CANDIDATES = 2;   // fiches ouvertes par requête (après matching titre)
const VF_SLOTS = 3;
const VOSTFR_SLOTS = 3;

// Préfixe de la clé xfield -> extracteur. Les absents (netu, uptostream…) n'ont pas
// d'extracteur : on ne paie pas l'aller-retour. L'hôte est passé en `forceExtractor`
// car Voe tourne sur des domaines jetables que l'allowlist ne suit pas.
const HOST_TO_EXTRACTOR: Record<string, ExtractorId> = {
  voe: 'voe', uqload: 'uqload', doodstream: 'doodstream', vidoza: 'vidoza',
  vidmoly: 'vidmoly', streamtape: 'streamtape', mixdrop: 'mixdrop',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

const agent = makeDnsSafeAgent();

export interface DulourdStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR
  server: string;
  headers?: Record<string, string>;
}

async function fetchText(url: string, referer?: string, body?: string): Promise<string | null> {
  try {
    const cfg = {
      headers: {
        ...HEADERS,
        ...(referer ? { Referer: referer } : {}),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' } : {}),
      },
      timeout: REQ_TIMEOUT_MS,
      responseType: 'text' as const, transformResponse: (v: any) => v,
      validateStatus: () => true, maxRedirects: 4,
      httpsAgent: agent,
    };
    const { data, status } = body
      ? await axios.post<string>(url, body, cfg)
      : await axios.get<string>(url, cfg);
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

// --- 1. Recherche ------------------------------------------------------------

interface SearchItem { url: string; title: string; year?: number; }

/** Résultats DLE : un <a href="…/voir-series/…html"> suivi de l'alt du poster. */
function parseSearch(html: string): SearchItem[] {
  const out: SearchItem[] = [];
  const seen = new Set<string>();
  const rx = /href="(https?:\/\/[^"]*\/voir-series\/[^"]+\.html)"/g;
  for (const m of html.matchAll(rx)) {
    const url = m[1];
    // Les pages de saison/épisode portent la même racine : on ne garde que les FICHES.
    if (seen.has(url) || /-(saison|episode)\.html$/i.test(url)) continue;
    seen.add(url);
    const tail = html.slice(m.index! + m[0].length, m.index! + m[0].length + 500);
    const alt = tail.match(/alt="([^"]*)"/)?.[1] || '';
    if (!alt) continue;
    const year = alt.match(/\((\d{4})\)/)?.[1];
    out.push({ url, title: alt.replace(/\s*\(\d{4}\)\s*/, ' ').trim(), year: year ? Number(year) : undefined });
  }
  return out;
}

async function search(title: string): Promise<SearchItem[]> {
  const url = `${BASE()}/index.php?do=search&subaction=search&story=${encodeURIComponent(title)}`;
  const html = await fetchText(url, `${BASE()}/`);
  return html ? parseSearch(html) : [];
}

// --- 2/3. Page épisode : boutons de lecteurs ---------------------------------

interface PlayerRef { id: string; host: string; language: string; }

/**
 * Les boutons portent tout : `playEpisode(this, '<id>', '<hote>_<vf|vostfr>')`.
 * La langue est DÉCLARÉE (pas de devinette, contrairement à d'autres sources FR).
 */
function parsePlayers(html: string): PlayerRef[] {
  const out: PlayerRef[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/playEpisode\(this,\s*'(\d+)',\s*'([a-z0-9]+)_(vf|vostfr)'\)/gi)) {
    const key = `${m[2]}_${m[3]}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: m[1], host: m[2].toLowerCase(), language: m[3].toLowerCase() === 'vostfr' ? 'VOSTFR' : 'VF' });
  }
  return out;
}

/** Créneaux séparés par langue : sinon une série massivement VF noierait les VOSTFR. */
function selectPlayers(players: PlayerRef[]): PlayerRef[] {
  const usable = players.filter(p => HOST_TO_EXTRACTOR[p.host]);
  return [
    ...usable.filter(p => p.language === 'VF').slice(0, VF_SLOTS),
    ...usable.filter(p => p.language === 'VOSTFR').slice(0, VOSTFR_SLOTS),
  ];
}

// --- 4. Embed ----------------------------------------------------------------

async function embedUrl(p: PlayerRef, episodePage: string): Promise<string | null> {
  const xfield = `${p.host}_${p.language === 'VOSTFR' ? 'vostfr' : 'vf'}`;
  const html = await fetchText(
    `${BASE()}/engine/inc/serial/app/ajax/Season.php`,
    episodePage,
    `id=${encodeURIComponent(p.id)}&xfield=${encodeURIComponent(xfield)}&action=playEpisode`,
  );
  if (!html) return null;
  return html.match(/<iframe[^>]*\ssrc="(https?:\/\/[^"]+)"/i)?.[1] || null;
}

function serverName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return 'dulourd'; }
}

// --- Point d'entrée ----------------------------------------------------------

export async function getDulourdStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle?: string,
  year?: number,
  season?: number,
  episode?: number,
): Promise<DulourdStream[]> {
  if (mediaType !== 'series') return []; // catalogue 100 % séries
  if (!title || !season || !episode) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = `dulourd:${mode}:${title.toLowerCase()}:${season}:${episode}`;
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchDulourdStreams(extractorConfig, title, originalTitle, year, season, episode),
    { scope: 'dulourd', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchDulourdStreams(
  extractorConfig: ExtractorConfig,
  title: string,
  originalTitle: string | undefined,
  year: number | undefined,
  season: number,
  episode: number,
): Promise<DulourdStream[]> {
  const titles = [...new Set([title, originalTitle].filter(Boolean) as string[])];

  // 1. Recherche (titre FR d'abord — le site est FR), puis matching STRICT titre+année.
  let items: SearchItem[] = [];
  for (const t of titles) {
    items = await search(t);
    if (items.length) break;
  }
  const wanted: Wanted = { titles, year };
  const candidates = items
    .filter(it => accepts(wanted, { title: it.title, year: it.year, item: it }))
    .slice(0, MAX_CANDIDATES);
  if (!candidates.length) {
    console.log(`[Dulourd] pas de correspondance pour "${titles[0]}" (${year || '?'})`);
    return [];
  }

  const groups = await Promise.all(candidates.map(async (c): Promise<DulourdStream[]> => {
    // 2. L'URL d'épisode se construit : pas besoin de passer par la page saison.
    const episodePage = `${c.url.replace(/\.html$/i, '')}/${season}-saison/${episode}-episode.html`;
    const html = await fetchText(episodePage, c.url);
    if (!html) return [];

    // 3. Boutons -> (id, hôte, langue).
    const retenus = selectPlayers(parsePlayers(html));
    if (!retenus.length) return [];

    // 4. Un POST par lecteur retenu, EN PARALLÈLE.
    const perPlayer = await Promise.all(retenus.map(async (p): Promise<DulourdStream[]> => {
      const embed = await embedUrl(p, episodePage);
      if (!embed) return [];
      const r = await extractStream(embed, extractorConfig, HOST_TO_EXTRACTOR[p.host]);
      if (!r?.url) return [];
      if (/\.m3u8/i.test(r.url)) {
        // Sonde du manifeste : écarte les flux morts et donne la vraie résolution.
        const probe = await probeHlsResolution(r.url, r.headers || {});
        if (probe.dead) return [];
        return [{ url: r.url, quality: probe.quality || r.quality || 'HD', language: p.language, server: serverName(embed), headers: r.headers }];
      }
      return [{ url: r.url, quality: r.quality || 'HD', language: p.language, server: serverName(embed), headers: r.headers }];
    }));
    return perPlayer.flat();
  }));

  const streams = groups.flat();
  console.log(`[Dulourd] ${streams.length} flux pour "${titles[0]}" S${season}E${episode}`);
  return streams;
}

/** Sonde de santé : la recherche répond-elle avec des fiches ? */
export async function dulourdProbe(): Promise<boolean> {
  return (await search('flash')).length > 0;
}

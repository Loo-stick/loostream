import axios from 'axios';
import { extractStream, ExtractorConfig, ExtractorId } from '../extractors';
import { makeDnsSafeAgent } from '../dns-resolve';
import { cached } from '../cache';
import { probeHlsResolution } from '../hls-resolution';
import { makeEndpointConfig } from '../endpoint-config';

// CineStream (cinestream.info) — catalogue FILMS FR (VF + VOSTFR), ~25 000 fiches,
// Next.js App Router. FILMS UNIQUEMENT : le sitemap ne contient QUE des /film
// (25 094 sur 25 226 entrées, le reste étant de la navigation), toutes les routes
// séries plausibles rendent 404, et le composant lecteur ne prend qu'un `tmdbid`
// (aucun paramètre saison/épisode) -> on renvoie [] en série.
//
// Protocole (reversé le 2026-09-07 depuis le chunk de la route) :
//   La fiche /film/<slug>-<année> embarque, dans sa charge « flight » Next.js,
//   la liste des lecteurs et le tmdbid :
//     "players":[{"name":"Vidara"},{"name":"Voe"},…],"tmdbid":634649
//   et le composant compose l'URL du lecteur ainsi :
//     x = "/player/".concat(tmdbid, "/").concat(indexDuBouton)
//   Cette route est un simple GET (PAS une server action) qui rend une page
//   contenant <iframe id="iframe" src="<url d'embed>">.
//
// ⚠️ Le REFERER est le seul verrou : sans lui, /player/… rend « Lecteur
// indisponible » au lieu de l'embed. Il doit pointer la fiche du film.
//
// L'index d'un lecteur CHANGE d'un film à l'autre (index 0 = Vidara ici, un
// miroir Voe là) -> on lit toujours la liste sur la fiche, jamais d'index en dur.

const siteEndpoints = makeEndpointConfig('cinestream-endpoints.json', 'CINESTREAM_ENDPOINTS_CONFIG', {
  base: 'https://cinestream.info',
});
export const reloadCinestreamEndpoints = siteEndpoints.reload;
export const getCinestreamEndpoints = siteEndpoints.get;

const BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;
// Le nom du bouton NOMME l'hôte, ce qui vaut mieux que de le déduire du domaine :
// Voe (et filemoon) tournent en permanence sur des domaines jetables que
// l'allowlist ne peut pas suivre (jefferycontrolmodel.com, jessicayeahcatch.com…).
// On passe donc l'hôte en `forceExtractor` — le cas prévu par extractStream.
// Les noms absents de cette table (Save, Hxfile, upstream, vudeo, netu…) n'ont pas
// d'extracteur : on ne paie même pas l'aller-retour.
const NAME_TO_EXTRACTOR: Record<string, ExtractorId> = {
  vidara: 'vidara', voe: 'voe', lulutv: 'lulustream', vidsonic: 'vidsonic',
  fmx: 'filemoon', ddstream: 'doodstream', uqload: 'uqload', filelions: 'filelions',
  vmoly: 'vidmoly', swish: 'streamwish', stape: 'streamtape',
};

// Les lecteurs VOSTFR sont TOUJOURS en fin de liste (index 12+ sur les fiches à 15
// boutons) : prendre « les N premiers » ne servirait jamais de VOSTFR. On réserve
// donc des créneaux séparés pour chaque langue.
const VF_SLOTS = 4;
const VOSTFR_SLOTS = 2;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

export interface CinestreamStream {
  url: string;
  quality: string;
  language: string;   // VF | VOSTFR
  server: string;
  headers?: Record<string, string>;
}

// Le domaine est bloqué en DNS par le FAI de l'hébergeur (il résout en ::1, ce qui
// ferait taper l'addon sur son propre localhost). L'agent partagé rattrape ces
// réponses menteuses en re-résolvant via un DNS public ; SNI et Host inchangés.
const agent = makeDnsSafeAgent();

// --- HTTP --------------------------------------------------------------------

async function fetchText(url: string, referer?: string): Promise<string | null> {
  try {
    const { data, status } = await axios.get<string>(url, {
      headers: referer ? { ...HEADERS, Referer: referer } : HEADERS,
      timeout: REQ_TIMEOUT_MS,
      responseType: 'text', transformResponse: v => v,
      validateStatus: () => true, maxRedirects: 4,
      httpsAgent: agent,
    });
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

// --- Slug de la fiche --------------------------------------------------------
// `/film/<titre>-<année>` : minuscules, accents retirés, apostrophes SUPPRIMÉES
// sans séparateur (« L'Odyssée » -> `lodyssee-2026`, vu sur leur accueil), toute
// autre ponctuation devenant un tiret unique.
export function cinestreamSlug(title: string, year?: string | number): string {
  const base = (title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return year ? `${base}-${year}` : base;
}

// --- Fiche : liste des lecteurs + contrôle du tmdbid -------------------------

interface PlayerRef { index: number; name: string; }

/**
 * Lit la charge flight de la fiche. On y cherche le bloc `"players":[…]` et le
 * `"tmdbid":<n>` qui le suit (les guillemets y sont échappés : \"players\").
 * Renvoie null si la fiche n'existe pas ou ne concerne pas le film demandé.
 */
function parseFiche(html: string, tmdbId: string): PlayerRef[] | null {
  // Repérage LITTÉRAL, puis lecture bornée au bloc qui suit (quelques centaines
  // d'octets) — jamais de regex lâchée sur les 94 Ko de la page. On balaie toutes
  // les occurrences : un « players » parasite ailleurs ne doit pas nous arrêter.
  let at = html.indexOf('players');
  while (at >= 0) {
    const block = html.slice(at, at + 1200);
    const idMatch = block.match(/tmdbid\\?":\s*(\d+)/);
    if (idMatch) {
      // GARDE-FOU : la fiche atteinte DOIT être celle demandée. Un slug approximatif
      // peut tomber sur un autre film — on refuse plutôt que de servir autre chose.
      if (String(idMatch[1]) !== String(tmdbId)) return null;
      const players: PlayerRef[] = [];
      for (const m of block.matchAll(/name\\?":\s*\\?"([^"\\]+)/g)) {
        players.push({ index: players.length, name: m[1].trim() });
      }
      if (players.length) return players;
    }
    at = html.indexOf('players', at + 1);
  }
  return null;
}

const isVostfr = (name: string) => /vost|sub/i.test(name);
const languageOf = (name: string) => (isVostfr(name) ? 'VOSTFR' : 'VF');
const extractorFor = (name: string): ExtractorId | undefined =>
  NAME_TO_EXTRACTOR[name.toLowerCase().replace(/[^a-z0-9]/g, '')];

/**
 * Quels boutons interroger. Deux règles :
 *  - un bouton dont on ne sait pas extraire l'hôte est écarté d'emblée (sauf les
 *    VOSTFR, dont le nom ne dit pas l'hôte — c'est l'URL d'embed qui le révélera) ;
 *  - créneaux séparés VF / VOSTFR, sinon les VOSTFR (toujours en fin de liste)
 *    ne seraient jamais atteints.
 */
function selectPlayers(players: PlayerRef[]): PlayerRef[] {
  const vost = players.filter(p => isVostfr(p.name)).slice(0, VOSTFR_SLOTS);
  const vf = players.filter(p => !isVostfr(p.name) && extractorFor(p.name)).slice(0, VF_SLOTS);
  return [...vf, ...vost];
}

/** Hostname complet, clé de la table apprise (serverName ne rend que le 1er label). */
const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };

function serverName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return 'cinestream'; }
}

// --- Lecteur : /player/<tmdbId>/<index> -> URL d'embed ------------------------

async function embedUrl(tmdbId: string, index: number, referer: string): Promise<string | null> {
  const html = await fetchText(`${BASE()}/player/${encodeURIComponent(tmdbId)}/${index}`, referer);
  if (!html) return null;
  const src = html.match(/<iframe[^>]*\sid="iframe"[^>]*\ssrc="(https?:\/\/[^"]+)"/i)?.[1];
  return src || null;
}

// --- Point d'entrée ----------------------------------------------------------

export async function getCinestreamStreams(
  mediaType: 'movie' | 'series',
  extractorConfig: ExtractorConfig,
  tmdbId: string,
  title: string,          // titre FR (les sites FR indexent par titre français)
  originalTitle?: string,
  year?: number,
): Promise<CinestreamStream[]> {
  if (mediaType !== 'movie') return []; // catalogue 100 % films (cf. en-tête)
  if (!tmdbId || !title) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  return cached(
    `cinestream:${mode}:movie:${tmdbId}`, STREAMS_TTL_MS,
    () => fetchCinestreamStreams(extractorConfig, tmdbId, title, originalTitle, year),
    { scope: 'cinestream', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchCinestreamStreams(
  extractorConfig: ExtractorConfig,
  tmdbId: string,
  title: string,
  originalTitle?: string,
  year?: number,
): Promise<CinestreamStream[]> {
  const base = BASE();

  // 1. Trouver la fiche : titre FR d'abord, titre original en repli.
  let ficheUrl = '';
  let players: PlayerRef[] | null = null;
  for (const candidate of [...new Set([title, originalTitle].filter(Boolean) as string[])]) {
    const url = `${base}/film/${cinestreamSlug(candidate, year)}`;
    const html = await fetchText(url, `${base}/`);
    const parsed = html ? parseFiche(html, tmdbId) : null;
    if (parsed) { ficheUrl = url; players = parsed; break; }
  }
  if (!players) {
    console.log(`[CineStream] Aucune fiche pour "${title}" (${year || '?'}, tmdb ${tmdbId})`);
    return [];
  }

  // 2. Un aller-retour par lecteur retenu, EN PARALLÈLE (le Referer est la fiche).
  const retenus = selectPlayers(players);
  const embeds = await Promise.all(retenus.map(async p => ({ p, embed: await embedUrl(tmdbId, p.index, ficheUrl) })));

  // 3. Table `domaine -> hôte`, APPRISE sur les boutons nommés de CETTE fiche.
  //
  // Les boutons « vostfr N » ne nomment pas leur hébergeur, et ils atterrissent
  // sur les domaines jetables de Voe & co. que l'allowlist ne peut pas suivre —
  // ils étaient donc perdus (« Unknown embed host »). Or le site sert le MÊME parc
  // d'hébergeurs en VF et en VOSTFR, avec les domaines du jour : sur L'Odyssée,
  // les trois boutons VOSTFR tombaient exactement sur les domaines des boutons
  // Vidara / Voe / FMX de la même fiche. On apprend donc la correspondance ici,
  // au lieu de figer des domaines qui auront tourné demain.
  const learned = new Map<string, ExtractorId>();
  for (const { p, embed } of embeds) {
    const named = extractorFor(p.name);
    if (named && embed) learned.set(hostOf(embed), named);
  }

  const groups = await Promise.all(embeds.map(async ({ p, embed }): Promise<CinestreamStream[]> => {
    if (!embed) return [];
    // Ordre : nom du bouton (fiable) -> table apprise sur la fiche. Sans indice,
    // extractStream retombe sur la détection par domaine connu.
    const r = await extractStream(embed, extractorConfig, extractorFor(p.name) || learned.get(hostOf(embed)));
    if (!r?.url) return [];
    const language = languageOf(p.name);
    // HLS : sonder le manifeste écarte les flux morts et donne la vraie résolution
    // (les hôtes annoncent un « HD » générique). Repli sur ce que rend l'extracteur.
    if (/\.m3u8/i.test(r.url)) {
      const probe = await probeHlsResolution(r.url, r.headers || {});
      if (probe.dead) return [];
      return [{ url: r.url, quality: probe.quality || r.quality || 'HD', language, server: serverName(embed), headers: r.headers }];
    }
    return [{ url: r.url, quality: r.quality || 'HD', language, server: serverName(embed), headers: r.headers }];
  }));

  const streams = groups.flat();
  console.log(`[CineStream] ${streams.length} flux pour "${title}" (${retenus.length} lecteur(s) testé(s))`);
  return streams;
}

/** Sonde de santé : la fiche d'un film très stable répond-elle ? */
export async function cinestreamProbe(): Promise<boolean> {
  const html = await fetchText(`${BASE()}/film/oppenheimer-2023`, `${BASE()}/`);
  return !!html && html.includes('players');
}

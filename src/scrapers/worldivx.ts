// worldivx (www.worldivx.cc) — plateforme de téléchargement francophone dont le bouton
// « Voir en Streaming » ouvre un lecteur Byse. Films ET épisodes de séries FR récents
// (les releases anciennes n'ont pas de vidéo : `/e/0`).
//
// Recherche et correspondance reprises de /projets/aiosources (src/lib/worldivx.ts),
// éprouvées là-bas : le site n'a ni API ni identifiant IMDb/TMDB, on cherche donc le
// TITRE FRANÇAIS (les noms de release sont en français : « Cent.Dollars.Pour.Un.Sherif »
// pour True Grit) et Parsium lit les noms de release. Précision d'abord : mieux vaut
// aucun flux qu'un mauvais film.
//
// BYSE. Le lecteur affiche un captcha et un défi anti-bot, mais ils ne gardent que
// l'interface : `GET /api/videos/<code>/` rend un bloc `playback` chiffré AES-256-GCM
// ACCOMPAGNÉ de sa clé, découpée en `key_parts` (version v -> parts v et 31-v, cf. leur
// bundle videoPagesBundle). Aucun PoW ni captcha nécessaire pour obtenir le m3u8.
//
// LIVRAISON : PROXY OBLIGATOIRE. Vérifié le 2026-09-14 : la même URL rend 200 depuis
// le serveur et 404 depuis un téléphone en 4G — le jeton est lié au réseau (`asn=`).
// La réponse chiffrée expire en 15 min -> résolution au clic via /worldivx/stream.
// AUDIO : Byse ne garde qu'UNE piste (la 1re, la VO) — une release MULTi n'est donc plus
// multi ici, voir languageOf. Piège de diagnostic : depuis l'HÔTE, certains edges du CDN
// résolvent en ::1 (blocage DNS) et montrent le certificat du serveur lui-même, pris à
// tort pour un certificat expiré ; le conteneur (DNS Docker) voit le vrai serveur.

import axios from 'axios';
import * as crypto from 'node:crypto';
import { createCachedParser } from 'parsium-media';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';
import { makeDnsSafeAgent } from '../dns-resolve';
import { normalizeTokens } from '../matching';

const endpoints = makeEndpointConfig('worldivx-endpoints.json', 'WORLDIVX_ENDPOINTS_CONFIG', {
  base: 'https://www.worldivx.cc',
  byse: 'https://bysezoxexe.com',
});

export const getWorldivxEndpoints = endpoints.get;
export const reloadWorldivxEndpoints = endpoints.reload;

const BASE = () => String(endpoints.get().base).replace(/\/+$/, '');
const BYSE = () => String(endpoints.get().byse).replace(/\/+$/, '');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const agent = makeDnsSafeAgent();

// Un seul parseur à cache pour le processus : vingt fois moins cher que le nu.
const parser = createCachedParser();

const SEARCH_TTL_MS = 3 * 60 * 60 * 1000;
const CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // le lecteur d'une release ne change pas
const NO_VIDEO_TTL_MS = 12 * 60 * 60 * 1000;   // `/e/0` : la vidéo peut arriver plus tard
const MAX_RELEASES = 8;
const CONCURRENCY = 3;

async function getHtml(url: string, referer?: string): Promise<string | null> {
  try {
    const r = await axios.get<string>(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9', ...(referer ? { Referer: referer } : {}) },
      timeout: 12000, responseType: 'text', transformResponse: v => v, httpsAgent: agent,
      validateStatus: s => s < 500, maxContentLength: 4 * 1024 * 1024,
    });
    return r.status === 200 && typeof r.data === 'string' ? r.data : null;
  } catch {
    return null;
  }
}

// ── Recherche ────────────────────────────────────────────────────────────────

interface SearchRow { id: string; name: string; category: string | null }

/**
 * Texte masqué par la protection e-mail de Cloudflare (`<span class="__cf_email__">`) :
 * des noms de release y tombent (groupe « Dm@r »). Premier octet = clé, suite = XOR.
 */
function decodeCfEmail(hex: string): string {
  if (hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return '';
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function anchorText(inner: string): string {
  return inner
    .replace(/<span class="__cf_email__"[^>]*data-cfemail="([0-9a-fA-F]+)"[^>]*>[\s\S]*?<\/span>/g, (_m, hex: string) => decodeCfEmail(hex))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-fA-F]+|[a-z]+);/g, (whole, e: string) => {
      if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e] ?? whole;
    })
    .split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Lignes de résultats. On lit les SEULES cellules `liste-accueil-nom` : le reste de la
 * page (widget « Top ») est identique quelle que soit la requête, et c'est lui qu'on
 * lisait en croyant la recherche cassée.
 */
function parseSearchRows(html: string): SearchRow[] {
  const rows = new Map<string, SearchRow>();
  for (const chunk of html.split('<tr')) {
    if (!chunk.includes('liste-accueil-nom')) continue;
    const link = /href="\/detail\/(\d+)"\s*>([\s\S]*?)(?:<span class="WinOption1"|<\/a>)/.exec(chunk);
    if (!link) continue;
    const name = anchorText(link[2]);
    if (!name || rows.has(link[1])) continue;
    const category = /liste-accueil-type"\s+title="([^"]+)"/.exec(chunk);
    rows.set(link[1], { id: link[1], name, category: category?.[1] ?? null });
  }
  return [...rows.values()];
}

async function search(title: string): Promise<SearchRow[]> {
  const q = title.trim();
  if (!q) return [];
  return cached<SearchRow[]>(
    `worldivx:search:${q.toLowerCase()}`, SEARCH_TTL_MS,
    async () => {
      const html = await getHtml(`${BASE()}/recherche/${encodeURIComponent(q)}`, `${BASE()}/`);
      return html ? parseSearchRows(html) : [];
    },
    { scope: 'worldivx', shouldCache: r => r.length > 0, negativeTtlMs: 30 * 60 * 1000 },
  );
}

// ── Correspondance ───────────────────────────────────────────────────────────

const norm = (s: string) => normalizeTokens(s).join(' ');

// Catégories sans vidéo à proposer : jeux, logiciels, presse, livres, musique.
const OFF_TOPIC = /jeu|logiciel|ebook|livre|presse|journa|magazine|musique|audio/i;

interface Matched { row: SearchRow; resolution?: string }

function matchRelease(
  row: SearchRow, wanted: string[], mediaType: 'movie' | 'series',
  year: number | undefined, season?: number, episode?: number,
): Matched | null {
  if (row.category && OFF_TOPIC.test(row.category)) return null;
  // Le titre français est souvent ajouté entre parenthèses après le nom de release :
  // « The.End.Of.Oak.Street.2026.Multi.WEBRIP-NOTAG (La Fin d'Oak Street) ».
  const paren = /\(([^()]+)\)\s*$/.exec(row.name);
  const releaseName = paren ? row.name.slice(0, paren.index).trim() : row.name;

  let p: { title?: string; year?: number; seasons?: number[]; episodes?: number[]; isSeasonPack?: boolean; resolution?: string };
  try { p = parser.parse(releaseName); } catch { return null; }

  const names = [p.title, paren?.[1]].filter((t): t is string => !!t).map(norm).filter(t => t.length >= 2);
  if (!names.some(n => wanted.includes(n))) return null;

  const seasons = p.seasons ?? [];
  const episodes = p.episodes ?? [];
  if (mediaType === 'movie') {
    if (seasons.length > 0) return null;
    // Sans année, un homonyme (remake, jeu vidéo…) passerait : on refuse.
    if (!p.year || !year || Math.abs(p.year - year) > 1) return null;
  } else {
    // Épisode isolé uniquement : les packs de saison n'ont jamais de vidéo sur le site.
    if (!season || !episode || p.isSeasonPack) return null;
    if (!seasons.includes(season) || episodes.length !== 1 || episodes[0] !== episode) return null;
  }
  return { row, resolution: p.resolution };
}

/** Qualité RÉELLE : Byse ré-encode la 2160p en 1080p ; sans résolution = petit WEBRIP (~406p). */
function qualityOf(resolution?: string): string {
  if (resolution === '2160p' || resolution === '1440p' || resolution === '1080p') return '1080p';
  if (resolution === '720p') return '720p';
  return '480p';
}

/**
 * Langue RÉELLEMENT entendue. Byse ne garde qu'UNE piste audio (la première) : une
 * release « MULTi » n'est donc plus multi une fois passée chez lui. Sa 1re piste est la
 * version originale -> VF pour une œuvre française, VO sinon (vérifié 2026-09-14 :
 * Mutiny MULTi = anglais seul). Les releases FRENCH/TRUEFRENCH/VFF/VFQ n'ont que le
 * français.
 */
function languageOf(name: string, originalLanguage?: string): string {
  const t = name.toUpperCase();
  if (/\bVOSTFR\b|\bSUBFRENCH\b/.test(t)) return 'VOSTFR';
  if (/\bMULTI/.test(t)) return (originalLanguage || '').toLowerCase() === 'fr' ? 'VF' : 'VO';
  return 'VF'; // site francophone : FRENCH / TRUEFRENCH / VFF / VFQ / VF2 ou rien
}

// ── Lecteur Byse d'une release ───────────────────────────────────────────────

/** Code du lecteur Byse de la release, ou '' si la fiche n'a pas de vidéo (`/e/0`). */
async function byseCode(id: string): Promise<string> {
  return cached<string>(
    `worldivx:code:${id}`, CODE_TTL_MS,
    async () => {
      const html = await getHtml(`${BASE()}/stream/${id}`, `${BASE()}/detail/${id}`);
      if (!html) return '';
      const at = html.indexOf('/e/', html.indexOf('<iframe'));
      if (at < 0) return '';
      const code = /^\/e\/([A-Za-z0-9]+)/.exec(html.slice(at, at + 40))?.[1] || '';
      return code === '0' ? '' : code;
    },
    { scope: 'worldivx', shouldCache: c => c !== '', negativeTtlMs: NO_VIDEO_TTL_MS },
  );
}

export interface WorldivxStream {
  code: string;
  release: string;
  quality: string;
  language: string;
  server: string;
}

export async function getWorldivxStreams(
  mediaType: 'movie' | 'series',
  titles: string[],
  year?: number,
  season?: number,
  episode?: number,
  originalLanguage?: string,
): Promise<WorldivxStream[]> {
  const wanted = [...new Set(titles.filter(Boolean).map(norm).filter(t => t.length >= 2))];
  if (wanted.length === 0) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];

  // Une recherche par titre distinct (souvent 1 ou 2 : français et original coïncident
  // pour un film français).
  const queries = [...new Map(titles.filter(Boolean).map(t => [norm(t), t])).values()].slice(0, 3);
  const rows = new Map<string, SearchRow>();
  for (const found of await Promise.all(queries.map(q => search(q).catch(() => [] as SearchRow[])))) {
    for (const r of found) rows.set(r.id, r);
  }

  const matched = [...rows.values()]
    .map(r => matchRelease(r, wanted, mediaType, year, season, episode))
    .filter((m): m is Matched => m !== null)
    .slice(0, MAX_RELEASES);
  if (matched.length === 0) return [];

  const out: WorldivxStream[] = [];
  const queue = [...matched];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const code = await byseCode(m.row.id).catch(() => '');
      if (!code) continue;
      out.push({
        code,
        release: m.row.name,
        quality: qualityOf(m.resolution),
        language: languageOf(m.row.name, originalLanguage),
        server: 'byse',
      });
    }
  }));

  // 2160p et 1080p d'un même film donnent la même vidéo ré-encodée : un flux par
  // couple qualité/langue suffit. On garde la VRAIE release 1080p plutôt que la 2160p
  // ré-encodée (tri stable : les 2160p/1440p passent en dernier).
  const reencoded = (s: WorldivxStream) => /\b(2160p|1440p|4k|uhd)\b/i.test(s.release);
  out.sort((a, b) => Number(reencoded(a)) - Number(reencoded(b)));
  const seen = new Set<string>();
  const streams = out.filter(s => {
    const k = `${s.quality}|${s.language}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`[Worldivx] ${matched.length} release(s) retenue(s), ${streams.length} flux avec vidéo`);
  return streams;
}

// ── Résolution au clic ───────────────────────────────────────────────────────

const b64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

interface BysePlayback { iv: string; payload: string; key_parts: string[]; version: string }

/** Déchiffre le bloc `playback` avec la clé qu'il transporte (parts v et 31-v). */
function decryptPlayback(pb: BysePlayback): { sources?: { url?: string }[] } {
  const v = Number(pb.version);
  const parts = pb.key_parts;
  const chosen = v >= 1 && v <= 20 && 31 - v <= parts.length ? [parts[v - 1], parts[30 - v]] : parts;
  const key = Buffer.concat(chosen.map(b64u));
  const iv = b64u(pb.iv);
  const data = b64u(pb.payload);
  const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-gcm` as crypto.CipherGCMTypes, key, iv);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const clear = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return JSON.parse(clear.toString('utf8'));
}

/**
 * Rend l'URL HLS fraîche d'un lecteur Byse, et si son hôte a un certificat expiré
 * (l'appelant renonce alors : le proxy vérifie TLS).
 */
export async function resolveWorldivxStream(code: string): Promise<{ url: string; insecureTls: boolean } | null> {
  let data: any;
  try {
    const r = await axios.get(`${BYSE()}/api/videos/${encodeURIComponent(code)}/`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000, httpsAgent: agent,
    });
    data = r.data;
  } catch (e: any) {
    console.log(`[Worldivx] API Byse ${code} : ${e?.message || e}`);
    return null;
  }
  if (!data?.playback?.key_parts) return null;

  let url = '';
  try {
    url = decryptPlayback(data.playback).sources?.find(s => s.url)?.url || '';
  } catch (e: any) {
    console.log(`[Worldivx] déchiffrement Byse ${code} : ${e?.message || e}`);
    return null;
  }
  if (!url) return null;

  // Certificat du CDN : le proxy vérifie TLS, un hôte expiré ferait échouer la lecture
  // -> on le signale pour répondre une erreur claire plutôt qu'un lecteur qui tourne.
  let insecureTls = false;
  try {
    await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 8000, responseType: 'text', transformResponse: v => v, httpsAgent: agent });
  } catch (e: any) {
    const c = String(e?.code || e?.cause?.code || '');
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(c)) insecureTls = true;
  }
  return { url, insecureTls };
}

/** Santé : la recherche répond et rend des lignes. */
export async function worldivxProbe(): Promise<boolean> {
  const html = await getHtml(`${BASE()}/recherche/avatar`, `${BASE()}/`);
  return !!html && parseSearchRows(html).length > 0;
}

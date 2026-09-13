// KissKH : dramas et films asiatiques (Corée, Japon, Chine, Thaïlande…). Flux HLS
// DIRECT + sous-titres multi-langues, FR compris sur une bonne partie du catalogue.
//
// Porté depuis dramallyu (src/sources/direct/kisskh), où la source est éprouvée.
// Avant, on passait par le relais KissKH de Movix : même URL de flux, mais livrée
// dans le lot des providers Movix lents (coupé par l'early-exit) et SANS les
// sous-titres. Ici on parle directement à l'API du site.
//
// API : recherche, fiche et catalogue OUVERTS ; vidéo et sous-titres SIGNÉS (kkey).
// La signature n'est pas réimplémentée : on télécharge LEUR fonction (common.js),
// on l'évalue dans un bac à sable node:vm et on l'appelle. Quand KissKH retouche
// l'algorithme, la nouvelle version est récupérée toute seule.
//
// SÉCURITÉ RAM : leurs scripts sont du JS minifié sur une seule ligne. Toute
// recherche dedans se fait par indexOf littéral + slice, jamais par regex.
//
// NON PORTÉ : le déchiffrement des pistes `.txt`/`.txt1` (jamais validé sur un cas
// réel côté dramallyu, toutes les pistes sondées étaient en `.srt` clair). Ces
// pistes sont simplement ignorées.

import axios from 'axios';
import * as vm from 'node:vm';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';
import { makeDnsSafeAgent } from '../dns-resolve';
import { pickBest, expandTitles } from '../matching';
import { probeHlsResolution } from '../hls-resolution';

// ── Configuration ────────────────────────────────────────────────────────────

// Miroirs du site, du plus rapide au plus lent (mesuré côté dramallyu le 2026-08-16).
// Une signature calculée pour l'un est acceptée par les autres : basculer de miroir
// ne demande aucune re-découverte. `kisskh.ovh` est écarté (429 systématique).
const MIROIRS_DEFAUT = [
  'https://kisskh.co',
  'https://kisskh.id',
  'https://kisskh.do',
  'https://kisskh.la',
  'https://kisskh.nl',
];

// Constantes relevées le 2026-08-12. Remplacées à chaud par la re-découverte en cas
// de salve de 403 ; `base` (écrit depuis l'admin) force un miroir en tête de liste.
const endpoints = makeEndpointConfig<Record<string, unknown>>(
  'kisskh-endpoints.json',
  'KISSKH_ENDPOINTS_CONFIG',
  {
    base: '',
    miroirs: MIROIRS_DEFAUT,
    appVer: '2.8.10',
    platformVer: 4830201,
    appName: 'kisskh',
    viGuid: '62f176f3bb1b5b8e70e39932ad34a0c7',
    subGuid: 'VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp',
  },
);

export const getKisskhEndpoints = endpoints.get;

// Le Referer du site est exigé par l'API ; on le pose aussi sur le flux, comme
// dramallyu (certains CDN le vérifient selon les titres).
export const KISSKH_PLAYBACK_REFERER = 'https://kisskh.co/';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const agent = makeDnsSafeAgent();

function miroirs(): string[] {
  const c = endpoints.get();
  const liste = Array.isArray(c.miroirs) ? c.miroirs.map(String) : MIROIRS_DEFAUT;
  const force = c.base ? String(c.base) : '';
  const tous = force ? [force, ...liste.filter(m => m !== force)] : liste;
  const propres = tous.map(m => m.trim().replace(/\/+$/, '')).filter(Boolean);
  return propres.length > 0 ? propres : MIROIRS_DEFAUT;
}

let miroirActuel = 0;
let echecsMiroir = 0;

/** Rechargement (admin) : la liste a pu changer d'ordre, on repart du premier miroir. */
export function reloadKisskhEndpoints() {
  miroirActuel = 0;
  echecsMiroir = 0;
  return endpoints.reload();
}

const ECHECS_AVANT_BASCULE = 3; // un échec isolé est du bruit, trois d'affilée une panne

function signalerEchecMiroir(): void {
  const liste = miroirs();
  if (liste.length < 2 || ++echecsMiroir < ECHECS_AVANT_BASCULE) return;
  const ancien = liste[miroirActuel % liste.length];
  miroirActuel = (miroirActuel + 1) % liste.length;
  echecsMiroir = 0;
  console.log(`[KissKH] ${ancien} ne répond plus — bascule sur ${liste[miroirActuel]}`);
}

function base(): string {
  const liste = miroirs();
  return liste[miroirActuel % liste.length];
}

function constants() {
  const c = endpoints.get();
  return {
    appVer: String(c.appVer || '2.8.10'),
    platformVer: Number(c.platformVer) || 4830201,
    appName: String(c.appName || 'kisskh'),
    viGuid: String(c.viGuid || ''),
    subGuid: String(c.subGuid || ''),
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const MAX_SCRIPT_BYTES = 700 * 1024;

/** GET qui rend la réponse même en erreur (un 403 a un sens pour le kkey), null si réseau KO. */
async function httpGet<T>(
  url: string,
  opts: { text?: boolean; timeoutMs?: number; maxBytes?: number; api?: boolean } = {},
): Promise<{ status: number; data: T } | null> {
  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        ...(opts.api ? { Referer: `${base()}/`, Accept: 'application/json' } : {}),
      },
      timeout: opts.timeoutMs ?? 12000,
      validateStatus: () => true,
      maxRedirects: 4,
      maxContentLength: opts.maxBytes ?? 8 * 1024 * 1024,
      httpsAgent: agent,
      ...(opts.text ? { responseType: 'text' as const, transformResponse: [(v: unknown) => v] } : {}),
    });
    return { status: r.status, data: r.data as T };
  } catch {
    return null;
  }
}

async function getText(url: string, maxBytes?: number): Promise<string | null> {
  const r = await httpGet<string>(url, { text: true, timeoutMs: 20000, maxBytes });
  return r && r.status >= 200 && r.status < 400 && typeof r.data === 'string' ? r.data : null;
}

/** API ouverte : null si le miroir n'a pas répondu (compte pour la bascule). */
async function apiJson<T>(path: string): Promise<T | null> {
  const r = await httpGet<T>(`${base()}/api${path}`, { api: true });
  if (!r || r.status < 200 || r.status >= 300 || r.data == null) {
    signalerEchecMiroir();
    return null;
  }
  echecsMiroir = 0;
  return r.data;
}

// ── Signature kkey ───────────────────────────────────────────────────────────

type KeyFn = (...args: unknown[]) => string;
const KEY_FN_ARITY = 11; // signature distinctive : le nom change à chaque build, pas l'arité
const FN_TTL_MS = 12 * 60 * 60 * 1000;

let cachedFn: KeyFn | null = null;
let cachedAt = 0;
// « Jamais demandée » (normal au démarrage) et « demandée puis ratée » ne se
// confondent pas : seule la seconde mérite une alerte dans l'admin.
let dernierEchecSignature: number | null = null;
let discovering: Promise<KeyFn | null> | null = null;

/** Extrait les `src=` d'un HTML par balayage littéral (pas d'automate). */
function scriptSources(html: string): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = html.indexOf('src=', i)) !== -1) {
    const quote = html[i + 4];
    if (quote !== '"' && quote !== "'") { i += 4; continue; }
    const end = html.indexOf(quote, i + 5);
    if (end === -1) break;
    out.push(html.slice(i + 5, end));
    i = end + 1;
  }
  return out;
}

function absolute(b: string, src: string): string {
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  if (src.startsWith('//')) return 'https:' + src;
  return `${b}/${src.replace(/^\.?\//, '')}`;
}

/** Évalue un script dans un bac à sable et y cherche LA fonction à 11 paramètres. */
function extractKeyFn(source: string): KeyFn | null {
  const sandbox: Record<string, unknown> = {
    window: { navigator: {}, document: {} },
    navigator: {},
    document: {},
    console: { log: () => {}, error: () => {}, warn: () => {} },
  };
  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(source, context, { timeout: 5000 });
  } catch {
    // Un script qui casse au chargement peut avoir défini la fonction avant.
  }
  const candidates: KeyFn[] = [];
  for (const name of Object.getOwnPropertyNames(sandbox)) {
    if (name === 'window' || name === 'navigator' || name === 'document') continue;
    const value = sandbox[name];
    if (typeof value === 'function' && value.length === KEY_FN_ARITY) candidates.push(value as KeyFn);
  }
  if (candidates.length !== 1) return null;
  // La vraie fonction rend un hexadécimal majuscule par blocs AES de 32 caractères.
  try {
    const out = candidates[0](1, null, '2.8.10', 'x'.repeat(32), 1, 'k', 'k', 'k', 'k', 'k', 'k');
    if (typeof out !== 'string' || out.length < 32 || out.length % 32 !== 0) return null;
    if (!/^[0-9A-F]+$/.test(out)) return null;
  } catch {
    return null;
  }
  return candidates[0];
}

async function discoverKeyFn(): Promise<KeyFn | null> {
  const b = base();
  const html = await getText(`${b}/`);
  if (!html) {
    console.log(`[KissKH] ${b} injoignable — signature indisponible`);
    return null;
  }
  const scripts = scriptSources(html)
    .filter(s => s.endsWith('.js') || s.includes('.js?'))
    // Le bundle principal, les polyfills et le runtime ne la portent pas (1,2 Mo pour rien).
    .filter(s => !s.includes('main.') && !s.includes('polyfills.') && !s.includes('runtime.'))
    .filter(s => !s.includes('cloudflare') && !s.includes('accounts.google'))
    .map(s => absolute(b, s));
  for (const url of [...new Set(scripts)]) {
    const src = await getText(url, MAX_SCRIPT_BYTES);
    if (!src) continue;
    const fn = extractKeyFn(src);
    if (fn) {
      console.log(`[KissKH] fonction kkey trouvée dans ${url.split('/').pop()}`);
      return fn;
    }
  }
  console.log('[KissKH] aucune fonction kkey trouvée dans les scripts de la page');
  return null;
}

async function keyFn(): Promise<KeyFn | null> {
  if (cachedFn && Date.now() - cachedAt < FN_TTL_MS) return cachedFn;
  if (discovering) return discovering;
  discovering = discoverKeyFn()
    .then(fn => {
      if (fn) { cachedFn = fn; cachedAt = Date.now(); dernierEchecSignature = null; }
      else dernierEchecSignature = Date.now();
      return fn;
    })
    .finally(() => { discovering = null; });
  return discovering;
}

async function sign(episodeId: number, guid: string): Promise<string | null> {
  if (!guid) return null;
  const fn = await keyFn();
  if (!fn) return null;
  const c = constants();
  try {
    return fn(episodeId, null, c.appVer, guid, c.platformVer,
      c.appName, c.appName, c.appName, c.appName, c.appName, c.appName);
  } catch (e: any) {
    console.log(`[KissKH] échec de signature: ${String(e?.message || '').slice(0, 80)}`);
    return null;
  }
}

// Auto-réparation : un 403 isolé est du bruit (rate-limit, épisode retiré) ; une
// SALVE signifie que la signature ne passe plus -> re-découverte, avec un délai
// de grâce pour ne pas retélécharger leurs bundles à chaque hoquet.
const FORBIDDEN_THRESHOLD = 3;
const FORBIDDEN_WINDOW_MS = 5 * 60 * 1000;
const REDISCOVER_COOLDOWN_MS = 15 * 60 * 1000;
let forbiddenTimes: number[] = [];
let lastRediscover = 0;

function noteForbidden(): void {
  const now = Date.now();
  forbiddenTimes = forbiddenTimes.filter(t => now - t < FORBIDDEN_WINDOW_MS);
  forbiddenTimes.push(now);
  if (forbiddenTimes.length < FORBIDDEN_THRESHOLD) return;
  if (now - lastRediscover < REDISCOVER_COOLDOWN_MS) return;
  lastRediscover = now;
  forbiddenTimes = [];
  console.log('[KissKH] salve de 403 — re-découverte de la signature');
  cachedFn = null;
  cachedAt = 0;
  void rediscoverConstants();
}

/**
 * Re-extrait les constantes (guids, versions) du chunk du lecteur, dont le nom
 * change à chaque build. La table des chunks est lue dans runtime.js (~3,7 Ko, une
 * regex y est sans danger) ; les chunks eux-mêmes sont fouillés par indexOf.
 */
async function rediscoverConstants(): Promise<Record<string, unknown> | null> {
  const b = base();
  const html = await getText(`${b}/`);
  if (!html) { console.error(`[KissKH] re-découverte : ${b} injoignable`); return null; }
  const runtimeSrc = scriptSources(html).find(s => s.includes('runtime.'));
  if (!runtimeSrc) { console.error('[KissKH] re-découverte : aucun script runtime — le site a changé de forme'); return null; }
  const runtime = await getText(absolute(b, runtimeSrc));
  if (!runtime || runtime.length > 64 * 1024) { console.error('[KissKH] re-découverte : runtime illisible'); return null; }

  const chunkNames: string[] = [];
  for (const m of runtime.matchAll(/(\d+):"([0-9a-f]+)"/g)) chunkNames.push(`${m[1]}.${m[2]}.js`);

  for (const name of chunkNames) {
    const src = await getText(`${b}/${name}`, MAX_SCRIPT_BYTES);
    if (!src) continue;
    const at = src.indexOf('subGuid');
    if (at === -1) continue;
    const fenetre = src.slice(Math.max(0, at - 200), at + 400);
    const pick = (label: string): string | undefined => {
      const k = fenetre.indexOf(`${label}="`);
      if (k === -1) return undefined;
      const start = k + label.length + 2;
      const end = fenetre.indexOf('"', start);
      return end === -1 ? undefined : fenetre.slice(start, end);
    };
    const found: Record<string, unknown> = {};
    for (const label of ['subGuid', 'viGuid', 'appVer', 'appName']) {
      const v = pick(label);
      if (v) found[label] = v;
    }
    const pv = fenetre.indexOf('platformVer=');
    if (pv !== -1) {
      const digits = fenetre.slice(pv + 12, pv + 24).match(/^\d+/);
      if (digits) found.platformVer = Number(digits[0]);
    }
    if (found.subGuid && found.viGuid) {
      console.log(`[KissKH] constantes re-extraites depuis ${name} (appVer=${found.appVer}, platformVer=${found.platformVer})`);
      Object.assign(endpoints.get(), found); // à chaud, en mémoire
      return found;
    }
  }
  console.log('[KissKH] re-extraction des constantes infructueuse');
  return null;
}

// ── Administration ───────────────────────────────────────────────────────────

export interface EtatKisskh {
  courant: string;
  miroirs: string[];
  echecs: number;
  signature: 'chargee' | 'au-repos' | 'en-echec';
  signatureAgeMs: number | null;
  appVer: string;
  platformVer: number;
}

export function etatKisskh(): EtatKisskh {
  const c = constants();
  return {
    courant: base(),
    miroirs: miroirs(),
    echecs: echecsMiroir,
    signature: cachedFn ? 'chargee' : dernierEchecSignature !== null ? 'en-echec' : 'au-repos',
    signatureAgeMs: cachedFn && cachedAt ? Date.now() - cachedAt : null,
    appVer: c.appVer,
    platformVer: c.platformVer,
  };
}

/**
 * Re-découverte à la demande (bouton de l'admin) : relit les constantes dans leurs
 * chunks, jette la fonction de signature en mémoire et la recharge aussitôt pour
 * dire tout de suite si ça signe à nouveau — sans attendre une salve de 403.
 */
export async function rediscoverKisskh(): Promise<{ constantes: Record<string, unknown> | null; signature: boolean; etat: EtatKisskh }> {
  const constantes = await rediscoverConstants();
  cachedFn = null;
  cachedAt = 0;
  const fn = await keyFn();
  return { constantes, signature: fn !== null, etat: etatKisskh() };
}

// ── Client ───────────────────────────────────────────────────────────────────

interface KkSearchItem { id: number; title: string; episodesCount: number }
interface KkEpisode { id: number; number: number }
interface KkDrama { id: number; title: string; type: string; episodes: KkEpisode[] }
interface KkSubtitle { src: string; label: string; land: string }
interface KkVideo { Video: string | null }

async function search(query: string): Promise<KkSearchItem[]> {
  const q = query.trim();
  if (!q) return [];
  return cached<KkSearchItem[]>(
    `kisskh:search:${q.toLowerCase()}`,
    6 * 60 * 60 * 1000,
    async () => {
      const data = await apiJson<KkSearchItem[]>(`/DramaList/Search?q=${encodeURIComponent(q)}&type=0`);
      return Array.isArray(data) ? data : [];
    },
    { scope: 'kisskh', shouldCache: v => v.length > 0, negativeTtlMs: 30 * 60 * 1000 },
  );
}

async function drama(id: number): Promise<KkDrama | null> {
  return cached<KkDrama | null>(
    `kisskh:drama:${id}`,
    12 * 60 * 60 * 1000,
    async () => {
      const data = await apiJson<KkDrama>(`/DramaList/Drama/${id}?isq=false`);
      if (!data || !data.title) return null;
      // Les épisodes arrivent en ordre décroissant : on les remet dans l'ordre naturel.
      data.episodes = Array.isArray(data.episodes) ? [...data.episodes].sort((a, b) => a.number - b.number) : [];
      return data;
    },
    { scope: 'kisskh', shouldCache: v => v !== null },
  );
}

async function episodeVideo(episodeId: number): Promise<KkVideo | null> {
  return cached<KkVideo | null>(
    `kisskh:video:${episodeId}`,
    20 * 60 * 1000,
    async () => {
      const kkey = await sign(episodeId, constants().viGuid);
      if (!kkey) return null;
      const res = await httpGet<KkVideo>(
        `${base()}/api/DramaList/Episode/${episodeId}.png?err=false&ts=null&time=null&kkey=${kkey}`,
        { api: true, timeoutMs: 15000 },
      );
      if (!res) return null;
      if (res.status === 403) { noteForbidden(); return null; }
      if (res.status < 200 || res.status >= 300 || !res.data?.Video) return null;
      return res.data;
    },
    { scope: 'kisskh', shouldCache: v => v !== null },
  );
}

async function episodeSubs(episodeId: number): Promise<KkSubtitle[]> {
  return cached<KkSubtitle[]>(
    `kisskh:subs:${episodeId}`,
    60 * 60 * 1000,
    async () => {
      const kkey = await sign(episodeId, constants().subGuid);
      if (!kkey) return [];
      const res = await httpGet<KkSubtitle[]>(`${base()}/api/Sub/${episodeId}?kkey=${kkey}`, { api: true, timeoutMs: 15000 });
      if (!res) return [];
      if (res.status === 403) { noteForbidden(); return []; }
      if (res.status < 200 || res.status >= 300) return [];
      return Array.isArray(res.data) ? res.data : [];
    },
    { scope: 'kisskh', shouldCache: v => v.length > 0, negativeTtlMs: 10 * 60 * 1000 },
  );
}

// ── Correspondance titre / saison ────────────────────────────────────────────

// KissKH éclate les saisons en fiches distinctes : « Good Morning Call: Season 2 »,
// « The Good Doctor - Season 1 ». Une fiche sans saison explicite vaut saison 1.
function seasonInTitle(title: string): number | null {
  const m = title.match(/\bseason\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function stripSeason(title: string): string {
  return title
    .replace(/\s*[:\-–—]?\s*season\s*\d+\s*$/i, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .trim();
}

async function findDrama(titles: string[], type: 'movie' | 'series', season?: number): Promise<KkDrama | null> {
  const uniques = [...new Set(titles.filter(Boolean))];
  // Recherches en parallèle : un titre qui ne rend rien ne coûte pas le délai des suivants.
  const results = (await Promise.all(uniques.map(t => search(t).catch(() => [] as KkSearchItem[])))).flat();
  if (results.length === 0) return null;

  const wantedSeason = type === 'series' ? (season ?? 1) : undefined;
  // Pas de repli sur « toutes saisons » : servir l'épisode 1 de la saison 1 à qui
  // demande la saison 2 est pire que ne rien servir.
  const candidates = results
    .filter(r => wantedSeason === undefined || (seasonInTitle(r.title) ?? 1) === wantedSeason)
    .map(r => ({ title: stripSeason(r.title), item: r }));
  // Pas d'année : leur `releaseDate` est la date de mise en ligne, pas de sortie.
  const picked = pickBest({ titles: expandTitles(uniques) }, candidates);
  return picked ? drama(picked.item.id) : null;
}

// ── Langues ──────────────────────────────────────────────────────────────────

// KissKH renvoie de l'ISO 639-1 ; le reste de l'addon parle ISO 639-2 (fre, eng…).
const ISO1_TO_2: Record<string, string> = {
  fr: 'fre', en: 'eng', es: 'spa', pt: 'por', de: 'ger', it: 'ita', ar: 'ara', ru: 'rus',
  tr: 'tur', id: 'ind', ms: 'may', km: 'khm', vi: 'vie', th: 'tha', ja: 'jpn', ko: 'kor',
  zh: 'chi', hi: 'hin', tl: 'tgl', fil: 'tgl', my: 'bur', nl: 'dut', pl: 'pol',
};

function langCode(land: string): string {
  const c = (land || '').trim().toLowerCase();
  return ISO1_TO_2[c] || c || 'und';
}

/** Pistes chiffrées (repliques brouillées), non déchiffrables ici. */
function isEncryptedTrack(url: string): boolean {
  const path = url.split(/[?#]/)[0];
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'txt' || ext === 'txt1';
}

/** Anti-SSRF de la route de sous-titres : uniquement les CDN de KissKH. */
export function isKisskhSubtitleUrl(u: string): boolean {
  try {
    const p = new URL(u);
    const h = p.hostname.toLowerCase();
    return p.protocol === 'https:' && (h.endsWith('.cdnvideo11.shop') || h.includes('kisskh'));
  } catch {
    return false;
  }
}

// ── Point d'entrée ───────────────────────────────────────────────────────────

// Langues d'origine (TMDB, ISO 639-1) du catalogue KissKH : on ne l'interroge pas
// pour le reste, ce serait des recherches pour rien sur chaque film occidental.
const KISSKH_LANGS = new Set(['ja', 'ko', 'zh', 'cn', 'th', 'tw', 'vi', 'id', 'tl', 'ms']);

export function isKisskhLanguage(lang: string | undefined): boolean {
  return KISSKH_LANGS.has((lang || '').toLowerCase());
}

export interface KisskhSubtitle { url: string; lang: string; label: string }

export interface KisskhStream {
  url: string;
  title: string;
  quality: string;
  // Audio toujours en VO chez KissKH : VOSTFR seulement si une piste FR existe
  // réellement pour cet épisode.
  language: 'VOSTFR' | 'VO';
  headers: Record<string, string>;
  subtitles: KisskhSubtitle[];
}

const PROBE_BUDGET_MS = 4000;

export async function getKisskhStreams(
  type: 'movie' | 'series',
  titles: string[],
  season?: number,
  episode?: number,
): Promise<KisskhStream[]> {
  const d = await findDrama(titles, type, season);
  if (!d || d.episodes.length === 0) return [];

  // Un film n'a qu'un « épisode » ; pour une série on exige l'épisode exact.
  const ep = type === 'movie' ? d.episodes[0] : d.episodes.find(e => e.number === (episode ?? 1));
  if (!ep) return [];

  const [video, subs] = await Promise.all([episodeVideo(ep.id), episodeSubs(ep.id)]);
  if (!video?.Video) return [];

  const headers = { Referer: KISSKH_PLAYBACK_REFERER, 'User-Agent': UA };
  // Leur playlist n'annonce aucune résolution : on lit le SPS du 1er segment, borné
  // dans le temps pour ne pas retenir le fan-out.
  const probe = await Promise.race([
    probeHlsResolution(video.Video, headers),
    new Promise<null>(r => setTimeout(() => r(null), PROBE_BUDGET_MS)),
  ]);
  if (probe?.dead) return [];

  const subtitles = subs
    .filter(s => s.src && !isEncryptedTrack(s.src) && isKisskhSubtitleUrl(s.src))
    .map(s => ({ url: s.src, lang: langCode(s.land), label: s.label || s.land || 'Sous-titres' }));
  const hasFrench = subtitles.some(s => s.lang === 'fre');
  console.log(`[KissKH] « ${d.title} » ép. ${ep.number} -> flux OK, ${subtitles.length} sous-titre(s)${hasFrench ? ' dont FR' : ''}`);

  return [{
    url: video.Video,
    title: d.title,
    quality: probe?.quality || 'HD',
    language: hasFrench ? 'VOSTFR' : 'VO',
    headers,
    subtitles,
  }];
}

/** Santé : la recherche (endpoint ouvert) répond-elle ? */
export async function kisskhProbe(): Promise<boolean> {
  const r = await httpGet<unknown>(`${base()}/api/DramaList/Search?q=squid&type=0`, { api: true });
  return !!r && r.status === 200 && Array.isArray(r.data) && (r.data as unknown[]).length > 0;
}

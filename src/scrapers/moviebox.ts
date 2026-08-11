import axios from 'axios';
import crypto from 'crypto';
import { cached } from '../cache';
import { accepts, titlesMatch } from '../matching';

// MovieBox / aoneroom — the mobile "wefeed" API used by Onyx's CloudstreamProvider.
// One of the largest international catalogues (Netflix originals, K-dramas…),
// served as **direct signed MP4s** (free, not VIP-gated). Reverse-engineered from
// Onyx v1.7.237 — see the moviebox-onyx memory for the full protocol.
//
// Flow:
//   1. ensureBearer(): GET /tab-operating?tab=home (signed) → response header
//      x-user = {"token": <JWT>} → the anonymous mobile Bearer.
//   2. search/v2 (POST, signed + Bearer) → subjectId for a title.
//   3. play-info (GET, signed + Bearer) → data.streams[] = MP4 urls (self-signed,
//      no headers needed to fetch — just forward Range through the proxy).
//
// Every request carries signedHeaders(): X-Client-Token + an HMAC-MD5
// x-tr-signature over a canonical string whose query MUST be sorted+encoded.

const SECRET = Buffer.from('76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O', 'base64');
const UA = 'com.community.oneroom/50020045 (Linux; U; Android 13; en_US; 23078RKD5C; Build/TQ2A.230405.003; Cronet/135.0.7012.3)';
// api6 first, then the rest of the pool on failure.
const HOSTS = [
  'https://api6.aoneroom.com', 'https://api.aoneroom.com', 'https://api1.aoneroom.com',
  'https://api2.aoneroom.com', 'https://api3.aoneroom.com', 'https://api6sg.aoneroom.com',
];
const DEVICE_ID = crypto.randomBytes(8).toString('hex'); // stable for the process
// IMPORTANT: a MINIMAL device profile makes play-info return direct **MP4**
// streams. A full profile (os_version/brand/model/…) makes it return a single
// **DASH** manifest instead (which we can't serve to Stremio as easily). So keep
// this lean on purpose.
const X_CLIENT_INFO = JSON.stringify({
  package_name: 'com.community.oneroom', os: 'android', device_id: DEVICE_ID, region: 'FR',
});

const BEARER_TTL_MS = 30 * 60 * 1000;
const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const SUBJECT_TTL_MS = 6 * 60 * 60 * 1000; // subjectId/variants d'une série : stables -> cache long
const REQ_TIMEOUT_MS = 15000;

// The stream list carries the STABLE resolve params, not the volatile CDN URL.
// The signed MP4 URL (sign= / t=) is time-limited, so we resolve it fresh at
// play time via /moviebox/stream (resolveMovieboxUrl) and 302-redirect — the URL
// is never cached stale, and the direct MP4 goes client↔CDN (no proxy bandwidth).
export interface MovieboxStream {
  subjectId: string;
  se: number;
  ep: number;
  resourceId: string;  // pick this resource (encode) at play time
  quality: string;     // real resolution, e.g. "1080p"
  language: string;
  server: string;
  codec?: string;      // h264 / hevc → H.264 / H.265
  sizeBytes?: number;
  subLangs: string[];  // ISO 639-2 of matched subs available (fre/eng)
}

/** Health probe: can we obtain a mobile Bearer? (signature + hosts OK). */
export async function movieboxProbe(): Promise<boolean> {
  return !!(await ensureBearer(true));
}

const md5hex = (s: string | Buffer) => crypto.createHash('md5').update(s).digest('hex');
const reverse = (s: string) => s.split('').reverse().join('');

function signedHeaders(method: string, path: string, sortedQuery: string, body = ''): Record<string, string> {
  const ts = String(Date.now());
  const xClientToken = `${ts},${md5hex(reverse(ts))}`;
  const bodyLen = body ? String(Buffer.byteLength(body)) : '';
  const bodyMd5 = body ? md5hex(body) : '';
  const canonical = `${method}\napplication/json\napplication/json\n${bodyLen}\n${ts}\n${bodyMd5}\n${path}${sortedQuery ? '?' + sortedQuery : ''}`;
  const sig = crypto.createHmac('md5', SECRET).update(canonical).digest('base64');
  return {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Client-Token': xClientToken,
    'x-tr-signature': `${ts}|2|${sig}`,
    'X-Client-Info': X_CLIENT_INFO,
    'X-Client-Status': '0',
  };
}

/** Sorted + URL-encoded query string — must match what the signature covers. */
function sortedQuery(params: Record<string, string | number>): string {
  return Object.keys(params).sort()
    .map(k => `${k}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

// Signed request with host rotation. Returns the parsed JSON body (or null).
async function signedRequest(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string | number>,
  opts: { bearer?: string; body?: any; wantHeaders?: boolean } = {}
): Promise<{ data: any; headers: Record<string, string> } | null> {
  const q = method === 'GET' ? sortedQuery(params) : '';
  const bodyStr = opts.body ? JSON.stringify(opts.body) : '';
  for (const host of HOSTS) {
    try {
      const headers = signedHeaders(method, path, q, bodyStr);
      if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
      const url = `${host}${path}${q ? '?' + q : ''}`;
      const resp = await axios.request({
        method, url, headers, timeout: REQ_TIMEOUT_MS,
        data: method === 'POST' ? bodyStr : undefined,
        validateStatus: () => true,
      });
      if (resp.status >= 500 || resp.status === 0) continue; // rotate host
      return { data: resp.data, headers: resp.headers as Record<string, string> };
    } catch {
      continue; // network error → next host
    }
  }
  return null;
}

// --- Bearer (anonymous mobile session) ---
let bearerCache: { token: string; at: number } | null = null;

async function ensureBearer(force = false): Promise<string | null> {
  if (!force && bearerCache && Date.now() - bearerCache.at < BEARER_TTL_MS) {
    return bearerCache.token;
  }
  const r = await signedRequest('GET', '/wefeed-mobile-bff/tab-operating', { tab: 'home' });
  const xUser = r?.headers?.['x-user'] || r?.headers?.['X-User'];
  if (!xUser) {
    console.log('[MovieBox] Pas de header x-user (Bearer introuvable)');
    return null;
  }
  try {
    const token = JSON.parse(xUser).token;
    if (token) { bearerCache = { token, at: Date.now() }; return token; }
  } catch { /* fallthrough */ }
  console.log('[MovieBox] x-user illisible');
  return null;
}

// MovieBox indexe les SÉRIES « un résultat par saison » avec la saison DANS le titre :
// « Breaking Bad S1 », « Squid Game [English] S2 », « Rick and Morty S1-S9 » — et tous ces
// résultats pointent le MÊME subjectId (subject multi-saisons dont la liste `resource` porte
// se/ep pour toutes les saisons). Le matcher exige un token-set ÉGAL -> {breaking,bad,s1} ≠
// {breaking,bad} -> il rejetait toutes ces séries. On retire ces décorations (tag de langue
// entre [] + suffixe S<n> / S<a>-S<b>) pour matcher le titre de base.
function stripSeriesDecorations(title: string): string {
  return String(title)
    .replace(/\[[^\]]*\]/g, ' ')                         // [English], [French]...
    .replace(/\bS\d+(?:\s*-\s*S\d+)?\s*$/i, ' ')          // « S1 », « S1-S9 » en fin de titre
    .replace(/\s+/g, ' ')
    .trim();
}

// --- title → subjectId ---
async function findSubjectId(
  bearer: string, title: string, year: string, mediaType: 'movie' | 'series'
): Promise<string | null> {
  const wantType = mediaType === 'series' ? 2 : 1;
  const r = await signedRequest('POST', '/wefeed-mobile-bff/subject-api/search/v2', {},
    { bearer, body: { keyword: title, page: 1, perPage: 20, subjectType: 0 } });
  if (!r || r.data?.code !== 0) return null;

  const subjects: any[] = [];
  for (const grp of (r.data.data?.results || [])) {
    if (Array.isArray(grp?.subjects)) subjects.push(...grp.subjects);
  }
  // Sélection : titre token-set (base pour les séries) + année, puis dub anglais en dernier
  // (MovieBox expose des variantes « … English » / « [English] »).
  const wanted = { titles: [title], year: year ? Number(year) : undefined };
  const cands = subjects
    .filter(s => s?.subjectId && Number(s.subjectType) === wantType)
    .map(s => ({
      s,
      year: Number(String(s.releaseDate || s.year || '').match(/\d{4}/)?.[0]) || undefined,
      english: /\benglish\b/.test(String(s.title).toLowerCase()),
      base: mediaType === 'series' ? stripSeriesDecorations(s.title) : String(s.title),
    }))
    .filter(c => {
      if (!titlesMatch(wanted.titles, c.base)) return false;
      // Série : l'année d'un subject par-saison (S3 = 2010…) ne colle pas à first_air_date
      // (2008) -> ne PAS rejeter sur l'année ; le titre de base + subjectType série suffisent.
      // Film : on garde le contrôle d'année (via accepts, plus strict).
      if (mediaType === 'series') return true;
      return accepts(wanted, { title: c.s.title, year: c.year, item: c.s });
    })
    .sort((a, b) => Number(a.english) - Number(b.english)); // dub anglais (VO) en dernier -> VF d'abord

  return cands[0]?.s?.subjectId || null;
}

// Language variants — /subject-api/get returns dubs[], each a SEPARATE subjectId:
//   {subjectId, lanName, lanCode, original, type}  (type 0 = audio dub, 1 = sub)
// We keep the FR-relevant ones: original audio (VO), French dub (VF), French
// subs (VOSTFR). Foreign dubs/subs (Hindi, Arabic…) are dropped.
interface LangVariant { subjectId: string; language: string; }

async function getLangVariants(bearer: string, baseSubjectId: string): Promise<LangVariant[]> {
  const r = await signedRequest('GET', '/wefeed-mobile-bff/subject-api/get',
    { subjectId: baseSubjectId }, { bearer });
  const dubs: any[] = (r?.data?.code === 0 && r.data.data?.dubs) || [];
  if (!Array.isArray(dubs) || dubs.length === 0) {
    return [{ subjectId: baseSubjectId, language: 'VO' }]; // no variants → base is original
  }
  const out: LangVariant[] = [];
  for (const d of dubs) {
    if (!d?.subjectId) continue;
    const code = String(d.lanCode || '').toLowerCase();
    const isSub = Number(d.type) === 1;
    if (d.original) out.push({ subjectId: d.subjectId, language: 'VO' });
    else if (code === 'fr' && !isSub) out.push({ subjectId: d.subjectId, language: 'VF' });
    else if (code === 'fr' && isSub) out.push({ subjectId: d.subjectId, language: 'VOSTFR' });
    // else: foreign dub/sub → skip
  }
  // De-dup by language, keep order VF > VOSTFR > VO for the FR audience.
  const seen = new Set<string>();
  const order = { VF: 0, VOSTFR: 1, VO: 2 } as Record<string, number>;
  return out
    .filter(v => (seen.has(v.language) ? false : seen.add(v.language)))
    .sort((a, b) => (order[a.language] ?? 9) - (order[b.language] ?? 9));
}

// --- streams (aligned with Onyx: everything from `resource`) ---
// Onyx plays resource.list[] resourceLinks and pulls captions matched to the
// same resource, keeping subtitles in sync with the video encode. We do the same:
// resource gives real resolution + resourceId + codec + size + matched extCaptions.

const FR_SUB = new Set(['fr', 'fre', 'fra']);

/** Which of FR/EN subs are present on a resource item, as ISO 639-2. */
function subLangsOf(item: any): string[] {
  const caps: any[] = Array.isArray(item?.extCaptions) ? item.extCaptions : [];
  const out: string[] = [];
  if (caps.some(c => FR_SUB.has(String(c?.lan || '').toLowerCase()) && c?.url)) out.push('fre');
  if (caps.some(c => String(c?.lan || '').toLowerCase() === 'en' && c?.url)) out.push('eng');
  return out;
}

export async function getMovieboxStreams(
  tmdbId: string,
  mediaType: 'movie' | 'series',
  title: string,
  year: string,
  season?: number,
  episode?: number
): Promise<MovieboxStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const key = mediaType === 'series'
    ? `moviebox:series:${tmdbId}:${season}:${episode}`
    : `moviebox:movie:${tmdbId}`;
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchMovieboxStreams(mediaType, title, year, season, episode),
    { scope: 'moviebox', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchMovieboxStreams(
  mediaType: 'movie' | 'series', title: string, year: string, season?: number, episode?: number
): Promise<MovieboxStream[]> {
  const bearer = await ensureBearer();
  if (!bearer) return [];

  // subjectId (recherche titre) et variants (langues) sont IDENTIQUES pour tous les épisodes
  // d'une série -> on les cache longuement. Sans ça, chaque épisode refaisait search+get (~1,3s
  // en plus) et MovieBox ratait l'early-exit (1s). En binge, les épisodes suivants sont instantanés.
  const baseSubjectId = await cached(
    `moviebox:sid:${mediaType}:${title.toLowerCase()}:${year}`, SUBJECT_TTL_MS,
    () => findSubjectId(bearer, title, year, mediaType),
    { scope: 'moviebox', shouldCache: v => !!v },
  );
  if (!baseSubjectId) {
    console.log(`[MovieBox] Aucun subjectId pour "${title}" (${year})`);
    return [];
  }

  const se = mediaType === 'series' ? season! : 0;
  const ep = mediaType === 'series' ? episode! : 0;

  // Each language (VO/VF/VOSTFR) is a separate subjectId — pull its resource list
  // in parallel; one stream per real resolution, subs matched to that encode.
  const variants = await cached(
    `moviebox:var:${baseSubjectId}`, SUBJECT_TTL_MS,
    () => getLangVariants(bearer, baseSubjectId),
    { scope: 'moviebox', shouldCache: v => v.length > 0 },
  );
  const perVariant = await Promise.all(variants.map(async v => {
    const list = await getResourceList(bearer, v.subjectId, se, ep);
    const out: MovieboxStream[] = [];
    const seenRes = new Set<string>();
    for (const item of list) {
      const link = item.resourceLink || item.sourceUrl;
      const resId = String(item.resourceId || '');
      const res = Number(item.resolution) || 0;
      if (!link || !resId || !res) continue;
      // BUG FIX : pour une série, l'API `resource` renvoie une liste PLATE de TOUS les
      // épisodes dispos (chacun avec ses champs `se`/`ep`), en IGNORANT les params se/ep
      // qu'on envoie. Sans filtre on prenait le 1er item -> le même épisode pour tous.
      // On ne garde que l'épisode demandé (films : se/ep=0, pas de filtre).
      if (mediaType === 'series' && (Number(item.se) !== se || Number(item.ep) !== ep)) continue;
      const quality = `${res}p`;
      if (seenRes.has(quality)) continue; // one per resolution per language
      seenRes.add(quality);
      const subLangs = subLangsOf(item);
      // VO + sous-titres FR dispos = VOSTFR (Version Originale Sous-Titrée FR).
      const language = (v.language === 'VO' && subLangs.includes('fre')) ? 'VOSTFR' : v.language;
      out.push({
        subjectId: v.subjectId, se, ep, resourceId: resId, quality, language,
        server: 'moviebox', codec: item.codecName, sizeBytes: Number(item.size) || 0,
        subLangs,
      });
    }
    return out;
  }));

  const streams = perVariant.flat();
  console.log(`[MovieBox] Returning ${streams.length} stream(s) pour "${title}" (${variants.map(v => v.language).join('/')})`);
  return streams;
}

/**
 * resource.list[] for a subjectId — items de l'épisode (se/ep) demandé, toutes résolutions.
 *
 * L'endpoint est PAGINÉ (perPage=10) et IGNORE les params se/ep : il renvoie TOUS les épisodes,
 * page par page, ORDONNÉS par (se, ep) croissant. Une série longue (Breaking Bad = 61) tient sur
 * ~7 pages -> charger seulement la page 1 ratait les saisons hautes. On pagine avec `page` (⚠️ ne
 * PAS ajouter perPage, qui casse la requête) jusqu'à trouver l'épisode voulu, avec early-stop dès
 * qu'on a dépassé (se, ep) — inutile de tout charger. Film (se/ep=0) : on renvoie la 1re page.
 */
// Une page de l'endpoint resource. ⚠️ On envoie TOUJOURS se=0/ep=0 : passer les vrais se/ep
// « window » la réponse et casse l'ordre de pagination (on ratait des saisons intermédiaires).
async function fetchResourcePage(bearer: string, subjectId: string, page: number): Promise<{ list: any[]; total: number; perPage: number } | null> {
  const r = await signedRequest('GET', '/wefeed-mobile-bff/subject-api/resource',
    { subjectId, se: 0, ep: 0, page }, { bearer });
  if (r?.data?.code !== 0) return null;
  const data = r.data.data;
  return {
    list: Array.isArray(data?.list) ? data.list : [],
    total: Number(data?.pager?.totalCount) || 0,
    perPage: Number(data?.pager?.perPage) || 10,
  };
}

async function getResourceList(bearer: string, subjectId: string, se: number, ep: number): Promise<any[]> {
  const isSeries = se > 0 || ep > 0;
  const p1 = await fetchResourcePage(bearer, subjectId, 1);
  if (!p1) return [];
  if (!isSeries) return p1.list; // film : une seule page d'encodes
  // L'endpoint est PAGINÉ (perPage=10) : une série longue (Breaking Bad = 61) tient sur ~7 pages.
  // La page 1 donne totalCount -> on lance TOUTES les pages restantes EN PARALLÈLE (latence ~2
  // aller-retours au lieu de 7 séquentiels -> MovieBox reste dans la fenêtre de l'early-exit).
  const all = [...p1.list];
  const totalPages = Math.min(30, Math.ceil(p1.total / p1.perPage) || 1);
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => fetchResourcePage(bearer, subjectId, i + 2))
    );
    for (const p of rest) if (p) all.push(...p.list);
  }
  return all.filter(it => Number(it.se) === se && Number(it.ep) === ep);
}

/** Find a resource item by resourceId (fresh call). */
async function findResourceItem(
  subjectId: string, se: number, ep: number, resourceId: string
): Promise<any | null> {
  const bearer = await ensureBearer();
  if (!bearer) return null;
  const list = await getResourceList(bearer, subjectId, se, ep);
  // Série : la liste contient TOUS les épisodes -> restreindre à celui demandé AVANT de
  // matcher le resourceId, sinon le fallback `|| pool[0]` peut re-servir le mauvais épisode.
  const scoped = (se || ep) ? list.filter(x => Number(x?.se) === se && Number(x?.ep) === ep) : list;
  const pool = scoped.length ? scoped : list;
  return pool.find(x => String(x?.resourceId || '') === resourceId) || pool[0] || null;
}

// Fresh, playable MP4 URL for a resource item — /moviebox/stream calls this at
// play time so the signed link is never stale.
export async function resolveMovieboxUrl(
  subjectId: string, se: number, ep: number, resourceId: string
): Promise<string | null> {
  const item = await findResourceItem(subjectId, se, ep, resourceId);
  return item?.resourceLink || item?.sourceUrl || null;
}


// Fresh subtitle CDN URL (SRT) for a resource item + language — matched to the
// same encode as the video, resolved at load time (no stale signed URL).
export async function resolveMovieboxSubtitle(
  subjectId: string, se: number, ep: number, resourceId: string, lang: string
): Promise<string | null> {
  const item = await findResourceItem(subjectId, se, ep, resourceId);
  const caps: any[] = Array.isArray(item?.extCaptions) ? item.extCaptions : [];
  const match = lang === 'fre'
    ? caps.find(c => FR_SUB.has(String(c?.lan || '').toLowerCase()))
    : caps.find(c => String(c?.lan || '').toLowerCase() === 'en');
  return match?.url || null;
}

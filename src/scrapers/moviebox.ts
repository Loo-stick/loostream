import axios from 'axios';
import crypto from 'crypto';
import { cached } from '../cache';

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

// --- title → subjectId ---
function normalize(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

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
  const target = normalize(title);
  const scored = subjects
    .filter(s => s?.subjectId && Number(s.subjectType) === wantType)
    .map(s => {
      const n = normalize(s.title);
      const yr = String(s.releaseDate || s.year || '').match(/\d{4}/)?.[0] || '';
      const yearOk = !year || !yr || Math.abs(Number(yr) - Number(year)) <= 1;
      // exact match > startsWith > includes ; english-dub variants sort after.
      let score = 0;
      if (n === target) score = 3; else if (n.startsWith(target) || target.startsWith(n)) score = 2;
      else if (n.includes(target)) score = 1;
      if (/\benglish\b/.test(String(s.title).toLowerCase())) score -= 1;
      return { s, score, yearOk };
    })
    .filter(x => x.score > 0 && x.yearOk)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.s?.subjectId || null;
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

  const baseSubjectId = await findSubjectId(bearer, title, year, mediaType);
  if (!baseSubjectId) {
    console.log(`[MovieBox] Aucun subjectId pour "${title}" (${year})`);
    return [];
  }

  const se = mediaType === 'series' ? season! : 0;
  const ep = mediaType === 'series' ? episode! : 0;

  // Each language (VO/VF/VOSTFR) is a separate subjectId — pull its resource list
  // in parallel; one stream per real resolution, subs matched to that encode.
  const variants = await getLangVariants(bearer, baseSubjectId);
  const perVariant = await Promise.all(variants.map(async v => {
    const list = await getResourceList(bearer, v.subjectId, se, ep);
    const out: MovieboxStream[] = [];
    const seenRes = new Set<string>();
    for (const item of list) {
      const link = item.resourceLink || item.sourceUrl;
      const resId = String(item.resourceId || '');
      const res = Number(item.resolution) || 0;
      if (!link || !resId || !res) continue;
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

/** resource.list[] for a subjectId (per-resolution encodes + matched captions). */
async function getResourceList(bearer: string, subjectId: string, se: number, ep: number): Promise<any[]> {
  const r = await signedRequest('GET', '/wefeed-mobile-bff/subject-api/resource',
    { subjectId, se, ep }, { bearer });
  return (r?.data?.code === 0 && Array.isArray(r.data.data?.list)) ? r.data.data.list : [];
}

/** Find a resource item by resourceId (fresh call). */
async function findResourceItem(
  subjectId: string, se: number, ep: number, resourceId: string
): Promise<any | null> {
  const bearer = await ensureBearer();
  if (!bearer) return null;
  const list = await getResourceList(bearer, subjectId, se, ep);
  return list.find(x => String(x?.resourceId || '') === resourceId) || list[0] || null;
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

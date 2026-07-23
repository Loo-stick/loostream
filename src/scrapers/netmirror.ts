import axios from 'axios';
import { cached } from '../cache';

// NetMirror v3 (2026-07) — méthode ONYX : on IGNORE le master et on RECONSTRUIT
// le manifeste en sondant le CDN. Reverse-engineering de l'APK Onyx v1.7.235
// (classe NetMirrorProvider : probeRealManifest / reconstructRealFilm /
// buildRealVideoManifest). Onyx ne se connecte JAMAIS et ne regarde aucune pub —
// il ignore le `status:"otp"` renvoyé par player.php.
//
// Pourquoi : depuis ~2026-07, le master (newtv/hls/<ott>/<id>.m3u8) ne renvoie plus
// que le PLACEHOLDER invité (`/files/220884/`, `in=unknown`) = 10 min d'écran blanc.
// MAIS les vrais fichiers restent servis sous l'id RÉEL du contenu.
//
// Flux (vérifié en live, HTTP pur, sans navigateur ni compte) :
//   1. POST net52.cc/verify.php (form, g-recaptcha-response=<n'importe quoi> — non
//      validé) -> Set-Cookie t_hash_t (session invité).
//   2. Base API : pool mobidetect (base64) -> GET <hôte>/checknewtv.php (headers app)
//      -> {token_hash: base64(url)} -> https://tv.imgcdn.kim
//   3. GET net52.cc/mobile[/hs|/pv]/search.php?s=<titre> -> id du contenu
//   4. GET <base>/newtv/hls/<ott>/<id>.m3u8 -> master PLACEHOLDER : sert UNIQUEMENT
//      à lire l'hôte CDN (ex. s20.freecdn1.top).
//   5. Le VRAI asset = l'id du contenu. Boucler i=0..3 sur
//      https://<cdn>/files/<id>/a/<i>/<i>.m3u8 jusqu'à #EXTINF -> piste audio réelle
//      (elle marche telle quelle) + préfixe de segment + nb segments + durées.
//   6. Vidéo : https://<cdn>/files/<id>/<qualité>/<préfixe>_<NNN>.jpg (pad 3),
//      sondée en Range: bytes=0-1 (206 = existe). 1080p/720p/480p.
//   7. On génère nous-mêmes le m3u8 (routes /netmirror/* de l'addon).
//
// Les segments sont du MPEG-TS déguisé en .jpg (sync byte 0x47 vérifié) -> le
// transformer .jpg -> video/mp2t du proxy local s'applique. Referer net52.cc.

const NET52_BASE = process.env.NETMIRROR_API_BASE || 'https://net52.cc';
const HLS_REFERER = 'https://net52.cc/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// UA + headers "app" (obligatoires pour checknewtv.php / newtv).
const APP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0';
const APP_XRW = 'NetmirrorNewTV v1.0';

// Pool de résolveurs d'hôte extrait de l'APK (base64) -> checknewtv.php -> base API.
const MOBIDETECT = [
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj', 'aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=', 'aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg==', 'aHR0cHM6Ly9tb2JpZGV0ZWN0cy50b3A=',
];
const FALLBACK_API_BASE = process.env.NETMIRROR_HLS_BASE || 'https://tv.imgcdn.kim';

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const COOKIE_TTL_MS = 30 * 60 * 1000;
const API_BASE_TTL_MS = 60 * 60 * 1000;
const REQ_TIMEOUT_MS = 12000;
const QUALITIES = ['1080p', '720p', '480p'];

// Les 3 catalogues. `prefix` = segment de chemin de search.php ; `ott` = cookie + chemin HLS.
const PLATFORMS: { ott: string; prefix: string; label: string }[] = [
  { ott: 'nf', prefix: '', label: 'Netflix' },
  { ott: 'hs', prefix: 'hs/', label: 'Disney+' },
  { ott: 'pv', prefix: 'pv/', label: 'Prime Video' },
];

export interface NetmirrorSub { code: string; name: string; uri: string; forced: boolean; }

// Un flux NetMirror reconstruit. On ne renvoie PAS d'URL jouable directement :
// l'addon génère le manifeste depuis ces paramètres (routes /netmirror/*).
export interface NetmirrorStream {
  quality: string;      // meilleure qualité sondée ('1080p' | '720p' | '480p')
  qualities: string[];  // toutes les qualités qui existent réellement
  cdnHost: string;      // ex. s20.freecdn1.top
  contentId: string;    // id RÉEL du contenu (≠ placeholder 220884)
  prefix: string;       // préfixe de segment (ex. 9986)
  segments: number;     // nb de segments vidéo
  avgDur: number;       // durée moyenne d'un segment (s)
  audioTracks: number[];// indices des pistes audio réelles (a/<i>/<i>.m3u8)
  audioLangs: { index: number; code: string; name: string }[]; // langue par piste
  subtitles: NetmirrorSub[];  // sous-titres listés par le master (subscdn.top)
  referer: string;      // Referer exigé par le CDN
  language: string;
  platform: string;     // 'Netflix' | 'Prime Video' | 'Disney+'
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Obtain (and cache) a guest t_hash_t cookie via verify.php.
async function getGuestCookie(): Promise<string | null> {
  return cached('netmirror:cookie', COOKIE_TTL_MS, async () => {
    try {
      const uuid = `${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
      const resp = await axios.post(
        `${NET52_BASE}/verify.php`,
        `g-recaptcha-response=${uuid}`,
        {
          headers: {
            'User-Agent': UA,
            'Referer': `${NET52_BASE}/`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: REQ_TIMEOUT_MS,
          maxRedirects: 0,
          validateStatus: s => s < 400 || s === 301 || s === 302,
        }
      );
      const setCookie: string[] = (resp.headers['set-cookie'] as string[]) || [];
      for (const c of setCookie) {
        const m = c.match(/t_hash_t=([^;]+)/);
        if (m) return decodeURIComponent(m[1]);
      }
      console.log('[Netmirror] verify.php returned no t_hash_t cookie');
      return null;
    } catch (e: any) {
      console.log(`[Netmirror] verify.php failed: ${e.message}`);
      return null;
    }
  }, { scope: 'netmirror', shouldCache: r => !!r, negativeTtlMs: 60 * 1000 });
}

// Search one OTT catalog; returns the best-matching id (or null).
async function searchPlatform(
  title: string,
  year: string,
  platform: { ott: string; prefix: string },
  cookie: string
): Promise<string | null> {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const { data } = await axios.get(
      `${NET52_BASE}/mobile/${platform.prefix}search.php`,
      {
        params: { s: title, t: ts },
        headers: {
          'User-Agent': UA,
          'Referer': `${NET52_BASE}/`,
          'Cookie': `t_hash_t=${cookie}; ott=${platform.ott}; hd=on`,
        },
        timeout: REQ_TIMEOUT_MS,
      }
    );

    const results: { id: string; t: string }[] = Array.isArray(data?.searchResult) ? data.searchResult : [];
    if (results.length === 0) return null;

    const target = normalizeTitle(title);
    // Prefer an exact normalized-title match, else a prefix/contains match.
    let best = results.find(r => normalizeTitle(r.t) === target);
    if (!best) best = results.find(r => {
      const n = normalizeTitle(r.t);
      return n.startsWith(target) || target.startsWith(n);
    });
    return best?.id || null;
  } catch (e: any) {
    console.log(`[Netmirror] search (${platform.ott}) failed: ${e.message}`);
    return null;
  }
}

// Base API "app" : pool mobidetect -> checknewtv.php -> {token_hash: base64(url)}.
async function resolveApiBase(): Promise<string> {
  const got = await cached('netmirror:apibase', API_BASE_TTL_MS, async () => {
    for (const b64 of MOBIDETECT) {
      try {
        const host = Buffer.from(b64, 'base64').toString('utf8').trim().replace(/\/$/, '');
        const { data } = await axios.get(`${host}/checknewtv.php`, { headers: appHeaders(), timeout: REQ_TIMEOUT_MS });
        const th = data?.token_hash;
        if (th) {
          const url = Buffer.from(String(th), 'base64').toString('utf8').trim().replace(/\/$/, '');
          if (url.startsWith('http')) return url;
        }
      } catch { /* hôte mort -> suivant */ }
    }
    return '';
  }, { scope: 'netmirror', shouldCache: r => !!r, negativeTtlMs: 5 * 60 * 1000 });
  return got || FALLBACK_API_BASE;
}

function appHeaders(ott = 'nf'): Record<string, string> {
  return {
    'User-Agent': APP_UA,
    'X-Requested-With': APP_XRW,
    'Ott': ott,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Accept': 'application/json, text/plain, */*',
  };
}

const cdnHeaders = () => ({ 'User-Agent': UA, 'Referer': HLS_REFERER });

// Le master placeholder est INUTILISABLE pour la vidéo, mais il porte l'hôte CDN
// ET les MÉTADONNÉES DE LANGUE des pistes audio (LANGUAGE=/NAME= par index a/<i>).
async function resolveMasterMeta(apiBase: string, ott: string, id: string):
  Promise<{ cdnHost: string; langs: Map<number, { code: string; name: string }>; subs: NetmirrorSub[] }> {
  const langs = new Map<number, { code: string; name: string }>();
  const subs: NetmirrorSub[] = [];
  try {
    const { data } = await axios.get<string>(`${apiBase}/newtv/hls/${ott}/${encodeURIComponent(id)}.m3u8`, {
      headers: { ...cdnHeaders(), Accept: '*/*' }, timeout: REQ_TIMEOUT_MS,
      responseType: 'text', transformResponse: r => r,
    });
    const txt = String(data || '');
    const m = txt.match(/https:\/\/([a-z0-9.-]+)\/files\//i);
    for (const line of txt.split('\n')) {
      if (/TYPE=AUDIO/.test(line)) {
        const idx = line.match(/\/a\/(\d+)\/\1\.m3u8/);
        if (!idx) continue;
        const code = (line.match(/LANGUAGE="([^"]+)"/i)?.[1] || 'und').toLowerCase();
        const name = (line.match(/NAME="([^"]+)"/i)?.[1] || code).replace(/^\d+\.\s*/, '');
        langs.set(parseInt(idx[1], 10), { code, name });
      } else if (/TYPE=SUBTITLES/.test(line)) {
        // Sous-titres listés par le master : URI absolue sur subscdn.top, utilisable
        // telle quelle (l'id du contenu est le VRAI id, pas le placeholder).
        const uri = line.match(/URI="([^"]+)"/i)?.[1];
        if (!uri) continue;
        const code = (line.match(/LANGUAGE="([^"]+)"/i)?.[1] || 'und').toLowerCase();
        const name = (line.match(/NAME="([^"]+)"/i)?.[1] || code).replace(/^\d+\.\s*/, '');
        const forced = /FORCED=YES/i.test(line);
        subs.push({ code, name, uri, forced });
      }
    }
    return { cdnHost: m ? m[1] : '', langs, subs };
  } catch { return { cdnHost: '', langs, subs }; }
}

// Politique langue (comme avant) : on écarte les doublages indiens, on garde VO/VF.
const DROP_LANG = /^(hin|ben|tam|tel|kan|mal|mar|pan|guj|urd)/;
function langLabel(codes: string[]): string {
  const hasFr = codes.some(c => /^(fr|fre|fra)/.test(c));
  const hasOther = codes.some(c => !/^(fr|fre|fra)/.test(c));
  if (hasFr && hasOther) return 'MULTI (VF+VO)';
  if (hasFr) return 'VF';
  return codes.length > 1 ? 'MULTI' : 'VO';
}

// Les pistes audio sont servies telles quelles SOUS L'ID RÉEL -> elles donnent le
// préfixe de segment, le nombre de segments et la durée moyenne.
// `candidates` = indices listés par le master (pas 0..3 : certains titres ont 20+
// pistes et le français est souvent au-delà). On ne sonde que les pistes retenues.
async function probeAudio(cdnHost: string, id: string, candidates: number[]):
  Promise<{ tracks: number[]; prefix: string; count: number; avg: number } | null> {
  const tracks: number[] = [];
  let info: { prefix: string; count: number; avg: number } | null = null;
  const list = candidates.length ? candidates : [0, 1, 2, 3];
  for (const i of list) {
    try {
      const { data } = await axios.get<string>(`https://${cdnHost}/files/${id}/a/${i}/${i}.m3u8`, {
        headers: cdnHeaders(), timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: r => r,
      });
      const txt = String(data || '');
      if (!txt.includes('#EXTINF')) continue;
      tracks.push(i);
      if (!info) {
        const seg = txt.split('\n').map(s => s.trim()).find(s => s && !s.startsWith('#')) || '';
        const durs = [...txt.matchAll(/#EXTINF:([\d.]+)/g)].map(m => parseFloat(m[1])).filter(n => !isNaN(n));
        if (!seg.includes('_') || durs.length === 0) continue;
        info = { prefix: seg.split('_')[0], count: durs.length, avg: durs.reduce((a, b) => a + b, 0) / durs.length };
      }
    } catch { /* piste absente */ }
  }
  return info ? { tracks, ...info } : null;
}

// ISO 639-1 (TMDB) -> 639-2 (manifestes netfree), pour reconnaître la VO.
const ISO1_TO_ISO2: Record<string, string> = {
  en: 'eng', fr: 'fra', es: 'spa', ko: 'kor', ja: 'jpn', zh: 'zho', de: 'deu',
  it: 'ita', pt: 'por', ru: 'rus', hi: 'hin', ar: 'ara', tr: 'tur', pl: 'pol',
  nl: 'nld', sv: 'swe', da: 'dan', no: 'nor', fi: 'fin', cs: 'ces', hu: 'hun',
  th: 'tha', vi: 'vie', id: 'ind', he: 'heb', uk: 'ukr', ro: 'ron', el: 'ell',
  ta: 'tam', te: 'tel', bn: 'ben', ml: 'mal', mr: 'mar', pa: 'pan', fa: 'fas',
};

/**
 * Faut-il exposer cette piste ?
 * On garde : la VO (langue d'ORIGINE du titre selon TMDB — indispensable pour un
 * film coréen/espagnol/japonais…), le FRANÇAIS (VF), l'anglais (utile et souvent
 * la VO), et `und` (souvent la piste d'origine non étiquetée).
 * Tout le reste (doublages) est écarté — y compris le hindi, SAUF si c'est la VO.
 */
function keepTrack(code: string, originalLanguage: string): boolean {
  const c = (code || 'und').toLowerCase();
  const orig = ISO1_TO_ISO2[(originalLanguage || '').toLowerCase()] || '';
  if (orig && c.startsWith(orig.slice(0, 3))) return true;   // VO réelle
  if (/^(fr|fre|fra)/.test(c)) return true;                  // VF
  if (c === 'und' || c === '') return true;                  // non étiquetée
  return /^(en|eng)/.test(c);                                // anglais
}

/** Libellé affiché, calculé par rapport à la VO du titre. */
function labelFor(codes: string[], originalLanguage: string): string {
  const orig = ISO1_TO_ISO2[(originalLanguage || '').toLowerCase()] || '';
  const hasFr = codes.some(c => /^(fr|fre|fra)/.test(c));
  const hasVo = codes.some(c => c === 'und' || (orig && c.startsWith(orig.slice(0, 3))) || (!orig && /^(en|eng)/.test(c)));
  if (hasFr && hasVo) return 'MULTI (VF+VO)';
  if (hasFr) return 'VF';
  return codes.length > 1 ? 'MULTI' : 'VO';
}

const segUrl = (cdnHost: string, id: string, q: string, prefix: string, n: number) =>
  `https://${cdnHost}/files/${id}/${q}/${prefix}_${String(n).padStart(3, '0')}.jpg`;

async function segExists(url: string): Promise<boolean> {
  try {
    const r = await axios.get(url, {
      headers: { ...cdnHeaders(), Range: 'bytes=0-1' }, timeout: 8000,
      validateStatus: () => true, responseType: 'arraybuffer',
    });
    return r.status === 206 || r.status === 200;
  } catch { return false; }
}

// Nb de segments vidéo : l'audio donne une excellente estimation ; on vérifie et on
// n'entre en dichotomie que si l'estimation est fausse (économise ~10 requêtes).
async function countSegments(cdnHost: string, id: string, q: string, prefix: string, estimate: number): Promise<number> {
  if (estimate > 0 && await segExists(segUrl(cdnHost, id, q, prefix, estimate - 1))) {
    if (!(await segExists(segUrl(cdnHost, id, q, prefix, estimate)))) return estimate;
  }
  let lo = 0, hi = Math.max(estimate * 2, 64);
  while (!(await segExists(segUrl(cdnHost, id, q, prefix, hi))) === false) { lo = hi; hi *= 2; if (hi > 20000) break; }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await segExists(segUrl(cdnHost, id, q, prefix, mid))) lo = mid; else hi = mid;
  }
  return lo + 1;
}

// Resolve a series episode's netfree content id for one catalog. netfree keys
// every episode by its own id (like a movie): post.php?id={seriesId} returns the
// season list + the selected season's episodes; episodes.php?s={seasonId}&page=N
// pages any season's episodes. Each episode's id feeds newtv/hls/{ott}/{id}.m3u8.
async function resolveEpisodeId(
  seriesId: string,
  season: number,
  episode: number,
  platform: { ott: string },
  cookie: string
): Promise<string | null> {
  const headers = () => ({
    'User-Agent': UA,
    'Referer': `${NET52_BASE}/`,
    'Cookie': `t_hash_t=${cookie}; ott=${platform.ott}; hd=on`,
  });
  const ts = () => Math.floor(Date.now() / 1000);
  const findEp = (eps: any[]): string | null => {
    const want = `e${episode}`;
    const m = Array.isArray(eps) ? eps.find(e => String(e?.ep || '').toLowerCase() === want) : null;
    return m?.id || null;
  };
  try {
    const { data: post } = await axios.get(`${NET52_BASE}/mobile/post.php`, {
      params: { id: seriesId, t: ts() }, headers: headers(), timeout: REQ_TIMEOUT_MS,
    });
    const seasons: any[] = Array.isArray(post?.season) ? post.season : [];
    const target = seasons.find(s => String(s?.s) === String(season));
    if (!target) return null;

    // Fast path: post.php already returned the requested season's episodes.
    const selected = seasons.find(s => String(s?.sele || '').includes('select'));
    if (selected && String(selected.s) === String(season)) {
      const id = findEp(post?.episodes);
      if (id) return id;
    }

    // Otherwise (or if not found on the selected page), page episodes.php.
    for (let page = 1; page <= 6; page++) {
      const { data: ep } = await axios.get(`${NET52_BASE}/mobile/episodes.php`, {
        params: { s: target.id, t: ts(), page }, headers: headers(), timeout: REQ_TIMEOUT_MS,
      });
      const id = findEp(ep?.episodes);
      if (id) return id;
      if (!ep?.nextPageShow) break;
    }
    return null;
  } catch (e: any) {
    console.log(`[Netmirror] episode resolve (${platform.ott}) failed: ${e.message}`);
    return null;
  }
}

export async function getNetmirrorStreams(
  title: string,
  year: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  originalLanguage = ''
): Promise<NetmirrorStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];

  const key = mediaType === 'series'
    ? `netmirror:series:${normalizeTitle(title)}:${season}:${episode}:${originalLanguage}`
    : `netmirror:movie:${normalizeTitle(title)}:${year}:${originalLanguage}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchNetmirrorStreams(title, year, mediaType, season, episode, originalLanguage),
    { scope: 'netmirror', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchNetmirrorStreams(
  title: string,
  year: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  originalLanguage = ''
): Promise<NetmirrorStream[]> {
  const cookie = await getGuestCookie();
  if (!cookie) return [];
  const label = mediaType === 'series' ? `${title} S${season}E${episode}` : `${title} (${year})`;
  const apiBase = await resolveApiBase();

  // Chaque catalogue en parallèle. Pour une série, l'id trouvé est celui de la
  // SÉRIE -> on le mappe vers l'id propre de l'épisode demandé.
  const masters = await Promise.all(
    PLATFORMS.map(async (p) => {
      const found = await searchPlatform(title, year, p, cookie);
      if (!found) return null;
      const contentId = mediaType === 'series'
        ? await resolveEpisodeId(found, season!, episode!, p, cookie)
        : found;
      if (!contentId) return null;

      // Le master (placeholder) donne l'hôte CDN + les langues des pistes audio.
      const { cdnHost, langs, subs } = await resolveMasterMeta(apiBase, p.ott, contentId);
      if (!cdnHost) return null;

      // Pistes candidates = celles listées par le master, filtrées VO+VF.
      // (fallback: les 4 premières si le master n'a pas listé de langues)
      const listed = [...langs.keys()].sort((a, b) => a - b);
      let candidates = listed.filter(i => keepTrack(langs.get(i)?.code || 'und', originalLanguage));
      if (!candidates.length) candidates = listed.length ? listed.slice(0, 4) : [0, 1, 2, 3];

      // L'id RÉEL porte les vrais fichiers : l'audio nous donne préfixe/nb/durée.
      const audio = await probeAudio(cdnHost, contentId, candidates);
      if (!audio) return null;

      // Ordre d'exposition : VO d'abord (elle sera DEFAULT dans le manifeste),
      // puis VF, puis le reste — sinon un film espagnol démarrerait en doublage
      // anglais juste parce que sa piste a un index plus bas.
      const origIso2 = ISO1_TO_ISO2[(originalLanguage || '').toLowerCase()] || '';
      const rank = (i: number): number => {
        const c = (langs.get(i)?.code || 'und').toLowerCase();
        if (origIso2 && c.startsWith(origIso2.slice(0, 3))) return 0;      // VO
        if (!origIso2 && (c === 'und' || /^(en|eng)/.test(c))) return 0;   // VO présumée
        if (/^(fr|fre|fra)/.test(c)) return 1;                             // VF
        if (c === 'und') return 2;
        return 3;
      };
      const tracks = [...audio.tracks].sort((a, b) => rank(a) - rank(b) || a - b);
      const codes = tracks.map(i => langs.get(i)?.code || 'und');

      // Quelles qualités existent vraiment ?
      const qualities: string[] = [];
      for (const q of QUALITIES) {
        if (await segExists(segUrl(cdnHost, contentId, q, audio.prefix, 0))) qualities.push(q);
      }
      if (qualities.length === 0) return null;

      const segments = await countSegments(cdnHost, contentId, qualities[0], audio.prefix, audio.count);
      if (segments < 30) return null; // trop court = contenu cassé (garde-fou d'Onyx)

      const s: NetmirrorStream = {
        quality: qualities[0],
        qualities,
        cdnHost,
        contentId,
        prefix: audio.prefix,
        segments,
        avgDur: audio.avg,
        audioTracks: tracks,
        audioLangs: tracks.map(i => ({ index: i, code: langs.get(i)?.code || 'und', name: langs.get(i)?.name || `Audio ${i + 1}` })),
        subtitles: subs,
        referer: HLS_REFERER,
        language: labelFor(codes, originalLanguage),
        platform: p.label,
      };
      return s;
    })
  );

  const streams = masters.filter((s): s is NetmirrorStream => s !== null);
  if (streams.length === 0) {
    console.log(`[Netmirror] No match for "${label}"`);
    return [];
  }
  console.log(
    `[Netmirror] "${label}" -> ${streams.map(s => `${s.platform} ${s.quality} ${s.language}`).join(', ')}`
  );
  return streams;
}

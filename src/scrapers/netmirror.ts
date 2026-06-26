import axios from 'axios';
import { cached } from '../cache';

// NetMirror, rebuilt 2026-06 against the **netfree** backend the official app +
// third-party clients (Onyx) actually stream from — reverse-engineered by MITMing
// Onyx live (redroid + mitmproxy). This is the real anonymous full-video path;
// it supersedes BOTH the dead net52 playlist.php (10-min /files/220884 placeholder)
// AND the net27 single-audio mp4 flow (Hindi-only, no language choice).
//
// Verified flow (movies):
//   1. POST https://net52.cc/verify.php  (body "g-recaptcha-response=<uuid>")
//        -> Set-Cookie t_hash_t (guest session, ~3 days). The recaptcha value is a
//           throwaway UUID; net52 does not validate it.
//   2. GET  https://net52.cc/mobile[/hs|/pv]/search.php?s=<title>&t=<unix>
//        Cookie: t_hash_t=<v>; ott=<nf|hs|pv>; hd=on
//        -> { status, searchResult:[{id, t}] }  (id = Netflix/Hotstar/Prime id)
//   3. GET  https://tv.imgcdn.kim/newtv/hls/<ott>/<id>.m3u8   (NO auth, NO cookie)
//        -> HLS master with EVERY audio track Netflix has (VO + VF when the title
//           has a French dub) + subtitles + 1080p/720p/480p variants.
//
// The variant/segment token (`...?in=<IP>::<hash>::<ts>::xx`) is bound to the IP
// that FETCHES the master — so this MUST be delivered via the LOCAL proxy (same
// server IP), not MediaFlow. Segments are `.jpg`-disguised mpeg-ts; the local
// proxy already transforms them (needsTransformer() sniffs the manifest).
//
// Multi-audio means we no longer drop Hindi or guess a language: we return one
// adaptive stream and the player picks the track. Series not wired yet (FrenchStream
// covers series VF); getNetmirrorStreams returns [] for series.

const NET52_BASE = process.env.NETMIRROR_API_BASE || 'https://net52.cc';
const HLS_BASE = process.env.NETMIRROR_HLS_BASE || 'https://tv.imgcdn.kim';
const HLS_REFERER = 'https://tv.imgcdn.kim/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const COOKIE_TTL_MS = 30 * 60 * 1000;
const REQ_TIMEOUT_MS = 12000;

// The OTT catalogs net52 mirrors. `prefix` is the search.php path segment; `ott`
// is both the search cookie value and the imgcdn HLS path segment.
// Netflix (nf) and Hotstar/Disney (hs) use numeric ids whose CDN sub-playlists
// serve real segments. Prime Video (pv) uses encoded base32 ids whose sub-playlists
// 404 (verified live) — kept here but filtered out by resolveMaster()'s liveness
// check, which drops any platform/title whose stream doesn't actually resolve.
const PLATFORMS: { ott: string; prefix: string; label: string }[] = [
  { ott: 'nf', prefix: '', label: 'Netflix' },
  { ott: 'hs', prefix: 'hs/', label: 'Disney+' },
  { ott: 'pv', prefix: 'pv/', label: 'Prime Video' },
];

export interface NetmirrorStream {
  quality: string;     // top resolution in the master ('1080p' | '720p' | …)
  url: string;         // HLS master m3u8 (multi-audio, multi-resolution)
  referer: string;     // Referer the imgcdn CDN expects
  language: string;    // 'MULTI (VF+VO)' | 'MULTI' | 'VO' | 'VF' …
  platform: string;    // 'Netflix' | 'Prime Video' | 'Disney+'
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

// Fetch the HLS master and derive quality + language labels from it.
async function resolveMaster(
  ott: string,
  id: string
): Promise<{ url: string; quality: string; language: string } | null> {
  const url = `${HLS_BASE}/newtv/hls/${ott}/${encodeURIComponent(id)}.m3u8`;
  try {
    const { data } = await axios.get<string>(url, {
      headers: { 'User-Agent': UA, 'Referer': HLS_REFERER, 'Accept': '*/*' },
      timeout: REQ_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: r => r,
    });
    if (typeof data !== 'string' || !data.includes('#EXTM3U')) return null;

    // Audio languages (TYPE=AUDIO ... LANGUAGE="xxx")
    const langs = new Set<string>();
    for (const m of data.matchAll(/TYPE=AUDIO[^\n]*LANGUAGE="([^"]+)"/g)) {
      langs.add(m[1].toLowerCase().slice(0, 3));
    }
    const hasFr = langs.has('fra') || langs.has('fre') || langs.has('fr');
    const hasOther = [...langs].some(l => l !== 'fra' && l !== 'fre' && l !== 'fr');
    let language: string;
    if (langs.size <= 1) {
      language = hasFr ? 'VF' : 'VO';
    } else {
      language = hasFr && hasOther ? 'MULTI (VF+VO)' : hasFr ? 'MULTI (VF)' : 'MULTI';
    }

    // Top resolution among the variant streams.
    let maxH = 0;
    for (const m of data.matchAll(/RESOLUTION=\d+x(\d+)/g)) {
      const h = parseInt(m[1], 10);
      if (h > maxH) maxH = h;
    }
    const quality = maxH >= 2160 ? '4K' : maxH >= 1080 ? '1080p' : maxH >= 720 ? '720p' : maxH >= 480 ? '480p' : 'HD';

    // Liveness check: some catalogs (Prime Video, a few Disney+ titles) return a
    // master whose variant playlists 404 on the CDN. Fetch the first variant URL
    // and drop the whole title if it doesn't actually resolve — never surface a
    // stream that won't play.
    const firstVariant = data.split('\n').map(l => l.trim()).find(l => l.startsWith('http'));
    if (!firstVariant) return null;
    try {
      const probe = await axios.get(firstVariant, {
        headers: { 'User-Agent': UA, 'Referer': HLS_REFERER },
        timeout: REQ_TIMEOUT_MS,
        responseType: 'text',
        transformResponse: r => r,
        validateStatus: () => true,
      });
      if (probe.status !== 200 || typeof probe.data !== 'string' || !probe.data.includes('#EXT')) {
        console.log(`[Netmirror] ${ott}/${id} variant not playable (${probe.status}) — dropping`);
        return null;
      }
    } catch {
      return null;
    }

    return { url, quality, language };
  } catch (e: any) {
    console.log(`[Netmirror] master ${ott}/${id} failed: ${e.message}`);
    return null;
  }
}

export async function getNetmirrorStreams(
  title: string,
  year: string,
  mediaType: 'movie' | 'series',
  _season?: number,
  _episode?: number
): Promise<NetmirrorStream[]> {
  // Series flow (per-episode netfree ids) not implemented yet.
  if (mediaType !== 'movie' || !title) return [];

  const key = `netmirror:movie:${normalizeTitle(title)}:${year}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchNetmirrorStreams(title, year),
    { scope: 'netmirror', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS }
  );
}

async function fetchNetmirrorStreams(title: string, year: string): Promise<NetmirrorStream[]> {
  const cookie = await getGuestCookie();
  if (!cookie) return [];

  // Search all three catalogs in parallel; a title may live in more than one.
  const ids = await Promise.all(
    PLATFORMS.map(p => searchPlatform(title, year, p, cookie).then(id => ({ p, id })))
  );

  const masters = await Promise.all(
    ids.map(async ({ p, id }) => {
      if (!id) return null;
      const m = await resolveMaster(p.ott, id);
      if (!m) return null;
      const s: NetmirrorStream = {
        quality: m.quality,
        url: m.url,
        referer: HLS_REFERER,
        language: m.language,
        platform: p.label,
      };
      return s;
    })
  );

  const streams = masters.filter((s): s is NetmirrorStream => s !== null);
  if (streams.length === 0) {
    console.log(`[Netmirror] No match for "${title}" (${year})`);
    return [];
  }
  console.log(
    `[Netmirror] "${title}" (${year}) -> ${streams.map(s => `${s.platform} ${s.quality} ${s.language}`).join(', ')}`
  );
  return streams;
}

import axios from 'axios';

// A source's API answering 200 says nothing about whether the stream plays.
// Dead CDNs routinely return a syntactically valid but empty manifest — and a
// player handed one of those just shows a black screen with no error, which is
// far worse than the source not being offered at all. So before we hand a URL
// to Stremio, confirm the manifest actually references variants or segments.
//
// Observed in the wild: Purstream's CDN went 404 while the Movix API kept
// answering 200, and MediaFlow turned the 404 into this stub:
//   #EXTM3U / #EXT-X-VERSION:3 / #EXT-X-TARGETDURATION:1
//   #EXT-X-PLAYLIST-TYPE:VOD / # Stream unavailable / #EXT-X-ENDLIST
// Valid HLS, zero #EXTINF. The regex below rejects it.

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIVE_TIMEOUT_MS = 8000;

/** Does this manifest body actually point at playable media? */
const HAS_MEDIA = /#EXT-X-STREAM-INF|#EXTINF|\.m3u8|\.ts(\?|$|\n)|\.jpg/i;

/**
 * Fetches the URL and reports whether it serves something playable.
 * HLS manifests are read and inspected; non-HLS (mp4/mkv) only get a HEAD.
 * Never throws — a failure to check is reported as not-live.
 */
export async function isStreamLive(
  url: string,
  opts: { isHls: boolean; headers?: Record<string, string> }
): Promise<boolean> {
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_UA, ...(opts.headers || {}) };
  try {
    if (!opts.isHls) {
      const r = await axios.head(url, {
        headers, timeout: LIVE_TIMEOUT_MS, validateStatus: () => true, maxRedirects: 3,
      });
      return r.status >= 200 && r.status < 400;
    }
    const r = await axios.get<string>(url, {
      headers,
      timeout: LIVE_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: v => v,
      validateStatus: () => true,
      maxRedirects: 3,
    });
    if (r.status < 200 || r.status >= 400 || typeof r.data !== 'string') return false;
    return HAS_MEDIA.test(r.data);
  } catch {
    return false;
  }
}

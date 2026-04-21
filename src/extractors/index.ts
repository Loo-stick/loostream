import axios from 'axios';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export interface ExtractedStream {
  url: string;
  quality: string;
  format: 'hls' | 'mp4';
  headers?: Record<string, string>;
}

export interface ExtractorConfig {
  useMediaFlow: boolean;
  mediaFlowUrl?: string;
  mediaFlowPassword?: string;
}

// Voe domains (they rotate frequently)
const VOE_DOMAINS = [
  'voe', 'voe.sx', 'vidara.so', 'vidara.to', 'smoki.cc', 'kinoger.ru',
  'ralphysuccessfull', 'audaciousdefaulthouse', 'launchreliantcleaverriver',
  'reputationsheriffkennethsand', 'greaseball6eventual20', 'timberwoodanotia',
  'yodelswartlike', 'figeterpiazine', 'chromotypic', 'wolfdyslectic',
  'charlestoughrace',
];

// Doodstream rotates between many TLDs and clone domains
const DOOD_DOMAINS = [
  'dood', 'doodstream', 'dsvplay', 'd0o0d', 'dooood', 'd0000d', 'ds2play', 'dood.re',
];

const FILEMOON_DOMAINS = [
  'filemoon', 'filmoon', 'moonlink', 'bysebuho', 'moonplayer',
];

const VIDOZA_DOMAINS = ['vidoza'];
const VIDMOLY_DOMAINS = ['vidmoly', 'molystream', 'vidhide'];
const STREAMTAPE_DOMAINS = ['streamtape', 'strcloud', 'shavetape', 'tapewithadblock'];
const MIXDROP_DOMAINS = ['mixdrop', 'mdrop', 'mdy48tn97'];
// sharecloudy.com / moovbob.fr / moovtop.fr are the same infra (same player format)
const SHARECLOUDY_DOMAINS = ['sharecloudy', 'moovbob', 'moovtop'];
const LULUSTREAM_DOMAINS = ['luluvdo', 'lulustream', 'lulu.st'];
const FILELIONS_DOMAINS = ['filelions', 'minochinos', 'javplaya', 'lionshare'];
const STREAMWISH_DOMAINS = ['streamwish', 'hgcloud', 'awish', 'embedwish', 'strwish'];

type ExtractorId = 'voe' | 'uqload' | 'doodstream' | 'filemoon' | 'vidoza' | 'vidmoly' | 'streamtape' | 'mixdrop' | 'sharecloudy' | 'lulustream' | 'filelions' | 'streamwish';

/**
 * Detect which extractor to use based on URL.
 * Returns an ID accepted both by our local fallback and MediaFlow's /extractor/video host param.
 */
export function detectExtractor(url: string): ExtractorId | null {
  const hostname = new URL(url).hostname.toLowerCase();

  if (VOE_DOMAINS.some(d => hostname.includes(d))) return 'voe';
  if (hostname.includes('uqload')) return 'uqload';
  if (DOOD_DOMAINS.some(d => hostname.includes(d))) return 'doodstream';
  if (FILEMOON_DOMAINS.some(d => hostname.includes(d))) return 'filemoon';
  if (VIDOZA_DOMAINS.some(d => hostname.includes(d))) return 'vidoza';
  if (VIDMOLY_DOMAINS.some(d => hostname.includes(d))) return 'vidmoly';
  if (STREAMTAPE_DOMAINS.some(d => hostname.includes(d))) return 'streamtape';
  if (MIXDROP_DOMAINS.some(d => hostname.includes(d))) return 'mixdrop';
  if (SHARECLOUDY_DOMAINS.some(d => hostname.includes(d))) return 'sharecloudy';
  if (LULUSTREAM_DOMAINS.some(d => hostname.includes(d))) return 'lulustream';
  if (FILELIONS_DOMAINS.some(d => hostname.includes(d))) return 'filelions';
  if (STREAMWISH_DOMAINS.some(d => hostname.includes(d))) return 'streamwish';

  return null;
}

/**
 * Extract video URL from Voe embed
 * Voe stores the HLS URL in a base64-encoded JSON or directly in the page
 */
export async function extractVoe(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const { data: html } = await axios.get(embedUrl, { headers: HEADERS, timeout: 10000 });

    // Method 1: Look for HLS URL in script
    const hlsMatch = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (hlsMatch) {
      return { url: hlsMatch[0], quality: 'HD', format: 'hls' };
    }

    // Method 2: Base64 encoded source
    const base64Match = html.match(/atob\(['"]([^'"]+)['"]\)/);
    if (base64Match) {
      const decoded = Buffer.from(base64Match[1], 'base64').toString('utf-8');
      const urlMatch = decoded.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/);
      if (urlMatch) {
        return { url: urlMatch[0], quality: 'HD', format: 'hls' };
      }
    }

    // Method 3: window.location redirect
    const redirectMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (redirectMatch) {
      return await extractVoe(redirectMatch[1]);
    }

    // Method 4: JSON source in script
    const jsonMatch = html.match(/'hls':\s*'([^']+)'/);
    if (jsonMatch) {
      return { url: jsonMatch[1], quality: 'HD', format: 'hls' };
    }

    console.log('[Extractor] Voe: No HLS URL found');
    return null;
  } catch (e: any) {
    console.log('[Extractor] Voe error:', e.message);
    return null;
  }
}

/**
 * Extract video URL from Uqload embed
 */
export async function extractUqload(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    // Normalize URL (remove embed- prefix if present)
    const normalizedUrl = embedUrl.replace('/embed-', '/');

    const { data: html } = await axios.get(normalizedUrl, { headers: HEADERS, timeout: 10000 });

    if (html.includes('File Not Found')) {
      console.log('[Extractor] Uqload: File not found');
      return null;
    }

    // Look for sources array
    const sourcesMatch = html.match(/sources:\s*\[["']([^"']+)["']\]/);
    if (sourcesMatch) {
      return {
        url: sourcesMatch[1],
        quality: 'HD',
        format: 'mp4',
        headers: { 'Referer': 'https://uqload.is/' }
      };
    }

    // Alternative: direct mp4 URL
    const mp4Match = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
    if (mp4Match) {
      return {
        url: mp4Match[0],
        quality: 'HD',
        format: 'mp4',
        headers: { 'Referer': 'https://uqload.is/' }
      };
    }

    console.log('[Extractor] Uqload: No video URL found');
    return null;
  } catch (e: any) {
    console.log('[Extractor] Uqload error:', e.message);
    return null;
  }
}


/**
 * Extract video URL from Sharecloudy / Moovbob iframe.
 * The m3u8 is inlined in a JWPlayer `sources: [{ file: "..." }]` block — no obfuscation.
 */
export async function extractSharecloudy(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const { data: html, request } = await axios.get(embedUrl, {
      headers: HEADERS,
      timeout: 10000,
      maxRedirects: 5,
    });

    const fileMatch = html.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/);
    if (!fileMatch) {
      console.log('[Extractor] Sharecloudy: No m3u8 URL found');
      return null;
    }

    const finalHost = request?.res?.responseUrl ? new URL(request.res.responseUrl).origin : 'https://moovbob.fr';

    return {
      url: fileMatch[1],
      quality: 'HD',
      format: 'hls',
      headers: { 'Referer': finalHost + '/' },
    };
  } catch (e: any) {
    console.log('[Extractor] Sharecloudy error:', e.message);
    return null;
  }
}


/**
 * Extract using MediaFlow Proxy's /extractor/video endpoint
 * Calls the endpoint and follows the redirect to get the final proxy URL
 * (Stremio doesn't follow 302 redirects for HLS streams)
 */
async function extractViaMediaFlow(
  embedUrl: string,
  extractor: string,
  config: ExtractorConfig
): Promise<ExtractedStream | null> {
  if (!config.mediaFlowUrl || !config.mediaFlowPassword) {
    return null;
  }

  // Map extractor IDs to MediaFlow host names (case-insensitive on the server)
  const hostMap: Record<string, string> = {
    'voe': 'Voe',
    'uqload': 'Uqload',
    'doodstream': 'Doodstream',
    'filemoon': 'FileMoon',
    'vidoza': 'Vidoza',
    'vidmoly': 'Vidmoly',
    'streamtape': 'Streamtape',
    'mixdrop': 'Mixdrop',
    'lulustream': 'LuluStream',
    'filelions': 'FileLions',
    'streamwish': 'StreamWish',
  };

  const host = hostMap[extractor];
  if (!host) {
    return null;
  }

  try {
    const mediaFlowBase = config.mediaFlowUrl.replace(/\/+$/, '');

    // Build extractor URL with redirect_stream=true
    const extractorUrl = new URL('/extractor/video', mediaFlowBase);
    extractorUrl.searchParams.set('host', host);
    extractorUrl.searchParams.set('api_password', config.mediaFlowPassword);
    extractorUrl.searchParams.set('d', embedUrl);
    extractorUrl.searchParams.set('redirect_stream', 'true');

    console.log(`[Extractor] Calling MediaFlow for ${extractor}: ${embedUrl}`);

    // Call the extractor and capture the redirect URL
    // Stremio doesn't follow 302 redirects for HLS streams, so we need to resolve it
    const response = await axios.get(extractorUrl.toString(), {
      maxRedirects: 0,
      validateStatus: (status) => status === 302 || status === 301 || status === 200,
      timeout: 15000,
      headers: HEADERS,
    });

    let finalUrl: string;

    if (response.status === 301 || response.status === 302) {
      // Got redirect - use the Location header
      finalUrl = response.headers['location'];
      if (!finalUrl) {
        console.log(`[Extractor] MediaFlow returned ${response.status} but no Location header`);
        return null;
      }
      console.log(`[Extractor] MediaFlow redirected to proxy URL`);
    } else if (response.status === 200) {
      // Direct response - might be the URL in the body
      if (typeof response.data === 'string' && response.data.startsWith('http')) {
        finalUrl = response.data.trim();
      } else {
        console.log(`[Extractor] MediaFlow returned 200 but unexpected body`);
        return null;
      }
    } else {
      return null;
    }

    // Determine format based on extractor type (informational — MediaFlow proxy handles actual delivery)
    const hlsExtractors = new Set(['voe', 'filemoon', 'vidmoly']);
    const format = hlsExtractors.has(extractor) ? 'hls' : 'mp4';

    return {
      url: finalUrl,
      quality: 'HD',
      format: format as 'hls' | 'mp4',
    };
  } catch (e: any) {
    console.log(`[Extractor] MediaFlow error for ${extractor}:`, e.message);
    return null;
  }
}

/**
 * Extract using local extractors (no MediaFlow)
 * Only Voe and Uqload are supported
 */
async function extractLocally(embedUrl: string, extractor: string): Promise<ExtractedStream | null> {
  switch (extractor) {
    case 'voe':
      return await extractVoe(embedUrl);
    case 'uqload':
      return await extractUqload(embedUrl);
    case 'sharecloudy':
      return await extractSharecloudy(embedUrl);
    default:
      return null;
  }
}

/**
 * Main extract function - uses MediaFlow if configured, otherwise local extractors
 */
export async function extractStream(
  embedUrl: string,
  config?: ExtractorConfig
): Promise<ExtractedStream | null> {
  const extractor = detectExtractor(embedUrl);

  if (!extractor) {
    console.log(`[Extractor] Unknown embed host: ${new URL(embedUrl).hostname}`);
    return null;
  }

  // Try MediaFlow first if configured
  if (config?.useMediaFlow && config.mediaFlowUrl) {
    const result = await extractViaMediaFlow(embedUrl, extractor, config);
    if (result) {
      return result;
    }
    console.log(`[Extractor] MediaFlow failed for ${extractor}, falling back to local`);
  }

  // Fall back to local extraction
  console.log(`[Extractor] Using local extractor for ${extractor}: ${embedUrl}`);
  return await extractLocally(embedUrl, extractor);
}

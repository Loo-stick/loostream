import axios from 'axios';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export interface ExtractedStream {
  url: string;
  quality: string;
  format: 'hls' | 'mp4';
}

export interface ExtractorConfig {
  useMediaFlow: boolean;
  mediaFlowUrl?: string;
  mediaFlowPassword?: string;
}

// Voe domains (they rotate frequently)
const VOE_DOMAINS = [
  'voe', 'voe.sx', 'vidara.so', 'smoki.cc', 'kinoger.ru',
  'ralphysuccessfull', 'audaciousdefaulthouse', 'launchreliantcleaverriver',
  'reputationsheriffkennethsand', 'greaseball6eventual20', 'timberwoodanotia',
  'yodelswartlike', 'figeterpiazine', 'chromotypic', 'wolfdyslectic',
];

// DoodStream domains
const DOOD_DOMAINS = [
  'dood', 'doodstream', 'd0o0d', 'do0od', 'd0000d', 'd000d',
  'doply', 'ds2play', 'ds2video', 'dsvplay', 'myvidplay', 'vidply',
];

/**
 * Detect which extractor to use based on URL
 */
export function detectExtractor(url: string): 'voe' | 'uqload' | 'doodstream' | 'vidoza' | 'netu' | null {
  const hostname = new URL(url).hostname.toLowerCase();

  if (VOE_DOMAINS.some(d => hostname.includes(d))) return 'voe';
  if (hostname.includes('uqload')) return 'uqload';
  if (DOOD_DOMAINS.some(d => hostname.includes(d))) return 'doodstream';
  if (hostname.includes('vidoza')) return 'vidoza';
  if (hostname.includes('netu') || hostname.includes('waaw') || hostname.includes('younetu')) return 'netu';

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
      return { url: sourcesMatch[1], quality: 'HD', format: 'mp4' };
    }

    // Alternative: direct mp4 URL
    const mp4Match = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
    if (mp4Match) {
      return { url: mp4Match[0], quality: 'HD', format: 'mp4' };
    }

    console.log('[Extractor] Uqload: No video URL found');
    return null;
  } catch (e: any) {
    console.log('[Extractor] Uqload error:', e.message);
    return null;
  }
}

/**
 * Extract video URL from DoodStream embed
 * DoodStream uses a token-based system that requires fetching a pass URL
 */
export async function extractDoodStream(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    // Normalize to /e/ format
    const videoId = embedUrl.split('/').pop()?.split('?')[0];
    const normalizedUrl = `https://dood.to/e/${videoId}`;

    const { data: html } = await axios.get(normalizedUrl, {
      headers: { ...HEADERS, Referer: normalizedUrl },
      timeout: 10000
    });

    if (html.includes('Video not found')) {
      console.log('[Extractor] DoodStream: Video not found');
      return null;
    }

    // Find the pass URL
    const passMatch = html.match(/\/pass_md5\/([^'"]+)/);
    if (!passMatch) {
      console.log('[Extractor] DoodStream: No pass URL found');
      return null;
    }

    const passUrl = `https://dood.to/pass_md5/${passMatch[1]}`;

    // Fetch the pass URL to get the video token
    const { data: tokenData } = await axios.get(passUrl, {
      headers: { ...HEADERS, Referer: normalizedUrl },
      timeout: 10000,
    });

    // Generate random string for the final URL
    const randomStr = Array.from({ length: 10 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
    ).join('');

    const videoUrl = `${tokenData}${randomStr}?token=${passMatch[1].split('/').pop()}&expiry=${Date.now()}`;

    return { url: videoUrl, quality: 'HD', format: 'mp4' };
  } catch (e: any) {
    console.log('[Extractor] DoodStream error:', e.message);
    return null;
  }
}

/**
 * Extract video URL from Vidoza embed
 */
export async function extractVidoza(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const { data: html } = await axios.get(embedUrl, { headers: HEADERS, timeout: 10000 });

    // Look for sourcesCode array
    const sourcesMatch = html.match(/sourcesCode\s*:\s*\[\{[^\]]*src:\s*"([^"]+)"/);
    if (sourcesMatch) {
      return { url: sourcesMatch[1], quality: 'HD', format: 'mp4' };
    }

    // Alternative pattern
    const mp4Match = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
    if (mp4Match) {
      return { url: mp4Match[0], quality: 'HD', format: 'mp4' };
    }

    console.log('[Extractor] Vidoza: No video URL found');
    return null;
  } catch (e: any) {
    console.log('[Extractor] Vidoza error:', e.message);
    return null;
  }
}

/**
 * Extract video URL from Netu/Waaw embed
 */
export async function extractNetu(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const { data: html } = await axios.get(embedUrl, { headers: HEADERS, timeout: 10000 });

    // Look for HLS URL
    const hlsMatch = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (hlsMatch) {
      return { url: hlsMatch[0], quality: 'HD', format: 'hls' };
    }

    // Look for mp4
    const mp4Match = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
    if (mp4Match) {
      return { url: mp4Match[0], quality: 'HD', format: 'mp4' };
    }

    console.log('[Extractor] Netu: No video URL found');
    return null;
  } catch (e: any) {
    console.log('[Extractor] Netu error:', e.message);
    return null;
  }
}

/**
 * Extract using MediaFlow Proxy's /extractor/video endpoint
 */
async function extractViaMediaFlow(
  embedUrl: string,
  extractor: string,
  config: ExtractorConfig
): Promise<ExtractedStream | null> {
  if (!config.mediaFlowUrl || !config.mediaFlowPassword) {
    return null;
  }

  // Map extractor names to MediaFlow host names
  const hostMap: Record<string, string> = {
    'voe': 'Voe',
    'uqload': 'Uqload',
    'doodstream': 'Doodstream',
    'vidoza': 'Vidoza',
    // Netu not supported by MediaFlow
  };

  const host = hostMap[extractor];
  if (!host) {
    return null;
  }

  try {
    const mediaFlowBase = config.mediaFlowUrl.replace(/\/+$/, '');
    const extractorUrl = new URL('/extractor/video', mediaFlowBase);
    extractorUrl.searchParams.set('host', host);
    extractorUrl.searchParams.set('api_password', config.mediaFlowPassword);
    extractorUrl.searchParams.set('d', embedUrl);
    extractorUrl.searchParams.set('redirect_stream', 'true');

    console.log(`[Extractor] Using MediaFlow for ${extractor}: ${embedUrl}`);

    // Return the MediaFlow URL directly - it will handle extraction and streaming
    return {
      url: extractorUrl.toString(),
      quality: 'HD',
      format: extractor === 'voe' ? 'hls' : 'mp4',
    };
  } catch (e: any) {
    console.log(`[Extractor] MediaFlow error for ${extractor}:`, e.message);
    return null;
  }
}

/**
 * Extract using local extractors (no MediaFlow)
 */
async function extractLocally(embedUrl: string, extractor: string): Promise<ExtractedStream | null> {
  switch (extractor) {
    case 'voe':
      return await extractVoe(embedUrl);
    case 'uqload':
      return await extractUqload(embedUrl);
    case 'doodstream':
      return await extractDoodStream(embedUrl);
    case 'vidoza':
      return await extractVidoza(embedUrl);
    case 'netu':
      return await extractNetu(embedUrl);
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

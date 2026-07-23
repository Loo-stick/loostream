import axios from 'axios';
import { unpackFromHtml, findStreamUrl } from './unpack';
import * as fs from 'fs';
import * as path from 'path';

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

export type ExtractorId ='voe' | 'uqload' | 'doodstream' | 'filemoon' | 'vidoza' | 'vidmoly' | 'streamtape' | 'mixdrop' | 'sharecloudy' | 'lulustream' | 'filelions' | 'streamwish' | 'fsvid' | 'vidzy' | 'mailru';

export const EXTRACTOR_IDS: ExtractorId[] = [
  'voe', 'uqload', 'doodstream', 'filemoon', 'vidoza', 'vidmoly',
  'streamtape', 'mixdrop', 'sharecloudy', 'lulustream', 'filelions',
  'streamwish', 'fsvid', 'vidzy', 'mailru',
];

export const DEFAULT_EXTRACTOR_DOMAINS: Record<ExtractorId, string[]> = {
  voe: [
    'voe', 'voe.sx', 'vidara.so', 'vidara.to', 'smoki.cc', 'kinoger.ru',
    'ralphysuccessfull', 'audaciousdefaulthouse', 'launchreliantcleaverriver',
    'reputationsheriffkennethsand', 'greaseball6eventual20', 'timberwoodanotia',
    'yodelswartlike', 'figeterpiazine', 'chromotypic', 'wolfdyslectic',
    'charlestoughrace',
  ],
  uqload: ['uqload'],
  doodstream: ['dood', 'doodstream', 'dsvplay', 'd0o0d', 'dooood', 'd0000d', 'ds2play', 'dood.re'],
  filemoon: ['filemoon', 'filmoon', 'moonlink', 'bysebuho', 'moonplayer'],
  vidoza: ['vidoza'],
  mailru: ['my.mail.ru', 'mail.ru', 'ok.ru', 'odnoklassniki'],
  vidmoly: ['vidmoly', 'molystream', 'vidhide'],
  streamtape: ['streamtape', 'strcloud', 'shavetape', 'tapewithadblock'],
  mixdrop: ['mixdrop', 'mdrop', 'mdy48tn97'],
  sharecloudy: ['sharecloudy', 'moovbob', 'moovtop'],
  lulustream: ['luluvdo', 'lulustream', 'lulu.st'],
  filelions: ['filelions', 'minochinos', 'javplaya', 'lionshare'],
  streamwish: ['streamwish', 'hgcloud', 'awish', 'embedwish', 'strwish'],
  // Serveurs FrenchStream ("premium" et "vidzy") : page avec JS packé P.A.C.K.E.R.
  fsvid: ['fsvid'],
  vidzy: ['vidzy'],
};

/**
 * Fusionne un JSON parsé (ou n'importe quelle valeur) avec les défauts.
 * Par clé : le tableau du JSON est utilisé s'il est un tableau de strings,
 * sinon le défaut. Entrée non-objet => tous les défauts.
 */
export function mergeExtractorDomains(parsed: unknown): Record<ExtractorId, string[]> {
  const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    ? parsed as Record<string, unknown>
    : {};
  const result = {} as Record<ExtractorId, string[]>;
  for (const id of EXTRACTOR_IDS) {
    const val = obj[id];
    if (Array.isArray(val) && val.every(v => typeof v === 'string')) {
      result[id] = val as string[];
    } else {
      result[id] = DEFAULT_EXTRACTOR_DOMAINS[id];
    }
  }
  return result;
}

/** Détection pure : teste un hostname contre un jeu de domaines fourni. */
export function detectExtractorIn(
  url: string,
  domains: Record<ExtractorId, string[]>,
): ExtractorId | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const id of EXTRACTOR_IDS) {
    if (domains[id].some(d => hostname.includes(d))) return id;
  }
  return null;
}

const EXTRACTOR_DOMAINS_PATH = process.env.EXTRACTOR_DOMAINS_CONFIG ||
  (fs.existsSync('/app/config/extractor-domains.json')
    ? '/app/config/extractor-domains.json'
    : path.join(process.cwd(), 'config', 'extractor-domains.json'));

let currentDomains: Record<ExtractorId, string[]> = { ...DEFAULT_EXTRACTOR_DOMAINS };

/** Charge les domaines depuis le JSON (fallback défauts). Met à jour l'état module. */
export function loadExtractorDomains(
  filePath: string = EXTRACTOR_DOMAINS_PATH,
): Record<ExtractorId, string[]> {
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      currentDomains = mergeExtractorDomains(raw);
      console.log(`[ExtractorDomains] Loaded from ${filePath}`);
      return currentDomains;
    }
    console.log(`[ExtractorDomains] File not found, using defaults: ${filePath}`);
  } catch (e: any) {
    console.error(`[ExtractorDomains] Error loading, using defaults: ${e.message}`);
  }
  currentDomains = mergeExtractorDomains(null);
  return currentDomains;
}

export function getExtractorDomains(): Record<ExtractorId, string[]> {
  return currentDomains;
}

export function reloadExtractorDomains(): Record<ExtractorId, string[]> {
  return loadExtractorDomains();
}

loadExtractorDomains();

try {
  if (fs.existsSync(EXTRACTOR_DOMAINS_PATH)) {
    fs.watch(EXTRACTOR_DOMAINS_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[ExtractorDomains] File changed, reloading...');
        setTimeout(() => loadExtractorDomains(), 100);
      }
    });
  }
} catch {
  // fs.watch non supporté — le reload reste possible via l'endpoint
}

/**
 * Detect which extractor to use based on URL, against the live domain set.
 * Returns an ID accepted both by our local fallback and MediaFlow.
 */
export function detectExtractor(url: string): ExtractorId | null {
  return detectExtractorIn(url, currentDomains);
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
/**
 * Hébergeurs dont la page cache l'URL du flux dans du JS packé P.A.C.K.E.R.
 * (fsvid.lol = serveur « premium » de FrenchStream, vidzy.org). Logique reprise
 * de l'app Onyx (FsvidExtractor/VidzyExtractor) : dépacker, puis chercher
 * src / file / sources[0] / une URL .m3u8. Le CDN exige Referer + Origin.
 */
export async function extractPackedJs(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const origin = new URL(embedUrl).origin;
    const { data } = await axios.get<string>(embedUrl, {
      headers: { ...HEADERS, Referer: `${origin}/` },
      timeout: 15000,
      responseType: 'text',
      transformResponse: r => r,
    });
    const js = unpackFromHtml(String(data || ''));
    if (!js) {
      console.log(`[Extractor] packed JS introuvable: ${embedUrl}`);
      return null;
    }
    const url = findStreamUrl(js);
    if (!url) {
      console.log(`[Extractor] URL de flux introuvable après dépack: ${embedUrl}`);
      return null;
    }
    return {
      url,
      quality: 'HD',
      format: url.includes('.m3u8') ? 'hls' : 'mp4',
      headers: { Referer: `${origin}/`, Origin: origin },
    };
  } catch (e: any) {
    console.log(`[Extractor] packedJs failed (${embedUrl}): ${e.message}`);
    return null;
  }
}

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
      // MediaFlow redirige en 301/302 MAIS AUSSI en 307/308 selon l'hébergeur
      // (doodstream renvoie 307) : accepter toute la famille des redirections.
      validateStatus: (status) => [200, 301, 302, 303, 307, 308].includes(status),
      timeout: 15000,
      headers: HEADERS,
    });

    let finalUrl: string;

    if ([301, 302, 303, 307, 308].includes(response.status)) {
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
    case 'fsvid':
    case 'vidzy':
      return await extractPackedJs(embedUrl);
    case 'mailru':
      return await extractMailru(embedUrl);
    default:
      return null;
  }
}

/**
 * Mail.ru video (my.mail.ru/video/embed/{id}). VoirDrama l'étiquette « Ok.ru »
 * mais sert bien des liens Mail.ru ; Onyx a les deux extracteurs, nous les
 * jetions faute d'en avoir un — alors que c'est le plus simple du lot.
 *
 * La page d'embed expose un metadataUrl ; ce JSON liste les rendus MP4 :
 *   { videos: [ { key: "1080p", url: "//cdn62.my.mail.ru/hv/….mp4?…" }, … ] }
 * Le Referer de l'embed suffit — le cookie video_key déposé au passage n'est pas
 * exigé par le CDN (vérifié : 206 avec et sans).
 */
async function extractMailru(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const { data: page } = await axios.get<string>(embedUrl, {
      headers: { ...HEADERS, Referer: 'https://voirdrama.to/' },
      timeout: 15000,
      responseType: 'text',
      transformResponse: v => v,
    });

    const meta = page.match(/metadataUrl["']?\s*[:=]\s*["']([^"']+)/);
    if (!meta) {
      console.log('[Extractor] Mail.ru: no metadataUrl');
      return null;
    }
    const metaUrl = meta[1].startsWith('//') ? `https:${meta[1]}` : new URL(meta[1], embedUrl).toString();

    const { data } = await axios.get(metaUrl, {
      headers: { ...HEADERS, Referer: embedUrl },
      timeout: 15000,
    });
    const videos: { key?: string; url?: string }[] = data?.videos || [];
    if (videos.length === 0) {
      console.log('[Extractor] Mail.ru: no videos in metadata');
      return null;
    }

    // Meilleur rendu disponible.
    const score = (k: string) => parseInt((k || '').replace(/\D/g, ''), 10) || 0;
    const best = [...videos].sort((a, b) => score(b.key || '') - score(a.key || ''))[0];
    if (!best?.url) return null;

    return {
      url: best.url.startsWith('//') ? `https:${best.url}` : best.url,
      quality: best.key || 'HD',
      format: 'mp4',
      headers: { Referer: embedUrl },
    };
  } catch (e: any) {
    console.log(`[Extractor] Mail.ru error: ${(e.message || '').slice(0, 80)}`);
    return null;
  }
}

/**
 * Main extract function - uses MediaFlow if configured, otherwise local extractors
 */
export async function extractStream(
  embedUrl: string,
  config?: ExtractorConfig,
  forceExtractor?: ExtractorId
): Promise<ExtractedStream | null> {
  // Domain-based detection first; fall back to a caller-provided host type when
  // the source authoritatively knows it (e.g. a provider routes voe/filemoon
  // through rotating domains the allowlist can't keep up with).
  const extractor = detectExtractor(embedUrl) || forceExtractor || null;

  if (!extractor) {
    console.log(`[Extractor] Unknown embed host: ${new URL(embedUrl).hostname}`);
    return null;
  }

  // fsvid/vidzy : extracteurs locaux uniquement (MediaFlow ne les connaît pas) —
  // inutile de payer un aller-retour qui échouera.
  // MediaFlow renvoie 502 sur ces hôtes ; notre extraction locale est fiable.
  const LOCAL_ONLY: string[] = ['fsvid', 'vidzy', 'mailru'];

  // Try MediaFlow first if configured
  if (config?.useMediaFlow && config.mediaFlowUrl && !LOCAL_ONLY.includes(extractor)) {
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

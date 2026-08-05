import axios from 'axios';
import * as https from 'https';
import * as vm from 'vm';
import { unpackFromHtml, findStreamUrl } from './unpack';
import * as fs from 'fs';
import * as path from 'path';

// Certains hôtes FR (uqload.bz, mirrors) tournent avec un certificat TLS expiré.
// Agent permissif réservé à ces extracteurs — on ne relaie que du média public,
// pas de secret, donc tolérer un cert périmé est acceptable ici.
const INSECURE_AGENT = new https.Agent({ rejectUnauthorized: false });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// Émulation IFRAME complète, reprise à l'identique du FsvidExtractor d'Onyx.
// fsvid (et consorts P.A.C.K.E.R.) discriminent le vrai flux du leurre /troll/
// selon que la requête RESSEMBLE à une vraie iframe de navigateur. Prouvé : nos
// headers minimaux -> 403/leurre ; ce set -> vrai flux 6/6. Referer/Origin sont
// ajoutés par appel (origine de l'embed).
const IFRAME_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Upgrade-Insecure-Requests': '1',
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

export type ExtractorId ='voe' | 'uqload' | 'doodstream' | 'filemoon' | 'vidoza' | 'vidmoly' | 'streamtape' | 'mixdrop' | 'sharecloudy' | 'lulustream' | 'filelions' | 'streamwish' | 'fsvid' | 'vidzy' | 'mailru' | 'sibnet' | 'livavid';

export const EXTRACTOR_IDS: ExtractorId[] = [
  'voe', 'uqload', 'doodstream', 'filemoon', 'vidoza', 'vidmoly',
  'streamtape', 'mixdrop', 'sharecloudy', 'lulustream', 'filelions',
  'streamwish', 'fsvid', 'vidzy', 'mailru', 'sibnet', 'livavid',
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
  vidoza: ['vidoza', 'videzz'],
  mailru: ['my.mail.ru', 'mail.ru', 'ok.ru', 'odnoklassniki'],
  sibnet: ['sibnet.ru', 'video.sibnet'],
  livavid: ['livavid'],
  vidmoly: ['vidmoly', 'molystream'],
  streamtape: ['streamtape', 'strcloud', 'shavetape', 'tapewithadblock'],
  mixdrop: ['mixdrop', 'mdrop', 'mdy48tn97'],
  sharecloudy: ['sharecloudy', 'moovbob', 'moovtop'],
  // Familles P.A.C.K.E.R. (extractPackedJs) — listes alignées sur Onyx.
  lulustream: ['luluvdo', 'lulustream', 'lulu.st', 'luluvid', 'luluvdoo'],
  filelions: ['filelions', 'minochinos', 'minochinoos', 'javplaya', 'lionshare',
    'vidhide', 'moflix-stream', 'dhtpre', 'dingtezuni', 'dintezuvio', 'morencius', 'lecteurvideo'],
  streamwish: ['streamwish', 'hgcloud', 'awish', 'embedwish', 'strwish', 'asnwish',
    'hlswish', 'playerwish', 'swishsrv', 'swiftplayers', 'uqloads.xyz'],
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

// Vidmoly (vidmoly.to/.me/.biz/.net) — le m3u8 est EN CLAIR dans la page :
// `sources:[{file:"…m3u8"}]` (pas de JS packé). Repris de l'app Onyx
// (VidMoLyExtractor.extractViaOkHttp). Le CDN exige Referer + Origin. Si la page
// est un challenge Cloudflare, seul un WebView le résout (hors de portée ici).
export async function extractVidmoly(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const origin = new URL(embedUrl).origin;
    const { data } = await axios.get<string>(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
        'Referer': `${origin}/`,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
      timeout: 15000, responseType: 'text', transformResponse: r => r, httpsAgent: INSECURE_AGENT,
    });
    const html = String(data || '');
    if (/challenges\.cloudflare\.com|just a moment|cf-turnstile/i.test(html)) {
      console.log('[Extractor] Vidmoly: challenge Cloudflare (WebView requis) — écarté');
      return null;
    }
    const m = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']*\.m3u8[^"']*)["']/i)
      || html.match(/file\s*:\s*["']([^"']*\.m3u8[^"']*)["']/i);
    if (!m) {
      console.log(`[Extractor] Vidmoly: pas de source m3u8: ${embedUrl}`);
      return null;
    }
    return { url: m[1], quality: 'HD', format: 'hls', headers: { Referer: `${origin}/`, Origin: origin } };
  } catch (e: any) {
    console.log(`[Extractor] Vidmoly error: ${(e.message || '').slice(0, 80)}`);
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

    const { data: html } = await axios.get(normalizedUrl, { headers: HEADERS, timeout: 10000, httpsAgent: INSECURE_AGENT });

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
// Certains hôtes (vidzy…) ne mettent plus l'URL en clair : le `src` est calculé
// par une fonction JS PURE (ex. base64 + XOR) — `src:(function(s){…})("…")`.
// On l'exécute dans une sandbox `vm` isolée (aucun accès require/fs/réseau,
// timeout 1s) : robuste à tout changement de clé/algorithme, contrairement à
// une regex figée. `atob` est fourni ; le reste (String, Array…) est natif au vm.
// Extrait l'IIFE `(function(...){...})(...)` qui suit `src:`/`file:` par équilibrage
// de parenthèses (en ignorant le contenu des chaînes) — un regex non-greedy casse
// sur les accolades imbriquées (boucle for de fsvid).
function extractIife(js: string): string | null {
  const m = js.match(/(?:src|file)\s*:\s*(?=\(function\b)/);
  if (!m) return null;
  const start = m.index! + m[0].length; // index du '(' ouvrant
  let depth = 0, str = '';
  for (let i = start; i < js.length; i++) {
    const c = js[i];
    if (str) { if (c === '\\') { i++; continue; } if (c === str) str = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      if (--depth === 0) {
        let j = i + 1; while (j < js.length && /\s/.test(js[j])) j++;
        if (js[j] === '(') continue;      // fin du groupe-fonction, l'appel suit
        return js.slice(start, i + 1);     // fin de l'appel -> IIFE complète
      }
    }
  }
  return null;
}

export function evalObfuscatedUrl(js: string): string | null {
  const iife = extractIife(js);
  if (!iife) return null;
  try {
    const out = vm.runInNewContext(
      iife,
      { atob: (s: string) => Buffer.from(s, 'base64').toString('binary') },
      { timeout: 1000 }
    );
    return typeof out === 'string' && /^https?:\/\//.test(out) ? out : null;
  } catch {
    return null;
  }
}

// Leurres / pubs (repris du estPub d'Onyx) : certains hôtes (fsvid…) servent une
// URL de mire /troll/ ou une pub à la place du flux quand ils flairent un scraper.
// On les rejette pour ne pas proposer une mire de 18s à l'utilisateur.
const DECOY_PATTERNS = [
  /\/troll\//i, /doubleclick/i, /googlesyndication/i, /imasdk/i, /googleads/i,
  /\/vast\b/i, /vast\.xml/i, /\/ads?\//i, /advert/i, /preroll/i,
];
export function isDecoyUrl(url: string): boolean {
  return DECOY_PATTERNS.some(p => p.test(url));
}

// Une passe d'extraction : récupère la page embed avec l'émulation iframe et
// tente de décoder une URL NON-leurre. Renvoie 'decoy' si la page ne contient
// qu'un leurre (/troll/) — signal pour réessayer, comme Onyx.
async function packedJsOnce(embedUrl: string, origin: string): Promise<string | null | 'decoy'> {
  const { data } = await axios.get<string>(embedUrl, {
    headers: { ...IFRAME_HEADERS, Referer: `${origin}/`, Origin: origin },
    timeout: 15000,
    responseType: 'text',
    transformResponse: r => r,
    httpsAgent: INSECURE_AGENT, // certains hôtes (vidoza…) ont un cert TLS expiré
  });
  const js = unpackFromHtml(String(data || ''));
  if (!js) return null;
  // Deux candidats : l'URL calculée par l'IIFE obfusquée (vidzy, et le VRAI flux
  // de fsvid) et l'URL en clair. fsvid met le vrai flux dans l'IIFE À CÔTÉ d'un
  // leurre /troll/ en clair -> on préfère toute URL NON-leurre (obfusquée d'abord).
  const decoded = evalObfuscatedUrl(js);
  const plain = findStreamUrl(js);
  const url = [decoded, plain].find(u => u && !isDecoyUrl(u)) || null;
  if (url) return url;
  // Une URL a été trouvée mais uniquement un leurre -> page LEURRE (comme Onyx).
  return (decoded || plain) ? 'decoy' : null;
}

// LuluVdo / LuluStream (luluvdo.com, lulustream.com, lulu.st, luluvid…).
// L'embed /e/<code> livre une URL CDN MORTE (acek-cdn = mini-PC Tailscale, cert
// cassé + 404). Le VRAI flux vient de l'endpoint /dl?op=embed (ce que le WebView
// d'Onyx charge — mais nous le faisons en PUR HTTP) : il renvoie du P.A.C.K.E.R.
// contenant une URL tnmr.org FRAÎCHE, à cert VALIDE. Prouvé : /dl -> unpack ->
// tnmr master 200, film complet (6842s). Le token est court -> extraire au plus
// près de la lecture. Headers CORS/XHR (Sec-Fetch cors/cross-site) OBLIGATOIRES,
// sinon 403 nginx (repris du LuluVdoExtractor d'Onyx).
// tnmr.org (CDN de luluvdo) fait de l'UA-gating MOBILE : UA desktop -> 403, UA
// mobile -> 200. Le token dure 8h (e=28800), donc pas de résolution paresseuse
// nécessaire — juste servir avec CE UA de bout en bout (probe multiaudio + Nuvio).
const LULU_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';

// Voie /dl?op=embed de la famille StreamWish/KVS (luluvdo, streamwish, filelions…).
// Renvoie une URL FRAÎCHE à cert valide (tnmr.org) là où l'embed direct /e|/v/<code>
// livre un CDN mort (acek-cdn). Renvoie null si l'hôte n'a pas cet endpoint (404) —
// l'appelant retombe alors sur l'unpack direct. Token 8h, mais UA MOBILE obligatoire.
async function tryDlEmbed(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const u = new URL(embedUrl);
    const origin = u.origin;
    const code = (u.pathname.split('/').filter(Boolean).pop() || '')
      .replace(/\.html$/, '').replace(/^embed-/, '');
    if (!code) return null;
    const dlUrl = `${origin}/dl?op=embed&file_code=${encodeURIComponent(code)}&auto=1&referer=`;
    const { data, status } = await axios.get<string>(dlUrl, {
      headers: { 'User-Agent': LULU_UA, Referer: `${origin}/e/${code}`, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      timeout: 15000, responseType: 'text', transformResponse: r => r, httpsAgent: INSECURE_AGENT,
      validateStatus: () => true,
    });
    if (status >= 400) return null; // hôte sans endpoint /dl -> repli sur l'unpack direct
    const js = unpackFromHtml(String(data || ''));
    if (!js) return null;
    const url = [evalObfuscatedUrl(js), findStreamUrl(js)].find(u => u && !isDecoyUrl(u)) || null;
    if (!url) return null;
    console.log(`[Extractor] /dl OK: ${new URL(url).host} <- ${embedUrl}`);
    // UA MOBILE + headers CORS/XHR requis (sinon 403 sur tnmr.org).
    return {
      url, quality: 'HD', format: 'hls',
      headers: {
        'User-Agent': LULU_UA,
        Referer: `${origin}/`, Origin: origin, Accept: '*/*',
        'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site',
      },
    };
  } catch { return null; }
}

// Famille StreamWish/KVS : /dl d'abord (URL vivante à cert valide), repli sur
// l'unpack direct de l'embed pour les hôtes sans /dl (ex. filelions/minochinos).
async function extractStreamWishFamily(embedUrl: string): Promise<ExtractedStream | null> {
  return (await tryDlEmbed(embedUrl)) || (await extractPackedJs(embedUrl));
}

// Retry anti-leurre : fsvid/vidzy servent PAR INTERMITTENCE une page /troll/ quand
// ils flairent un scraper ou throttlent une rafale de requêtes (IP/fenêtre). Le vrai
// flux revient à l'essai suivant — MAIS il faut ESPACER : Onyx attend ~1s entre
// chaque tentative (VidzyExtractor). On enchaînait 3 GET sans pause -> on retombait
// dans la même fenêtre de troll. 4 essais espacés de 800 ms laissent la fenêtre se
// rouvrir dans la même requête (coût user nul : l'early-exit répond déjà avec les
// autres sources, vidzy arrive juste un peu plus tard).
const PACKED_RETRIES = 4;
const PACKED_RETRY_DELAY_MS = 800;

export async function extractPackedJs(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const origin = new URL(embedUrl).origin;
    let url: string | null = null;
    for (let attempt = 0; attempt < PACKED_RETRIES; attempt++) {
      const r = await packedJsOnce(embedUrl, origin);
      if (r && r !== 'decoy') { url = r; break; }
      if (r === 'decoy') {
        console.log(`[Extractor] page leurre (/troll/) reçue, retry ${attempt + 1}/${PACKED_RETRIES}: ${embedUrl}`);
        if (attempt < PACKED_RETRIES - 1) await new Promise(res => setTimeout(res, PACKED_RETRY_DELAY_MS));
        continue;
      }
      break; // null franc (pas de packed JS / erreur de page) -> inutile d'insister
    }
    if (!url) {
      console.log(`[Extractor] pas de flux (non-leurre) après dépack: ${embedUrl}`);
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
      // Résolution rapide (renvoi d'un 302) : 8s max. Au-delà, MediaFlow pend/
      // rame — l'attendre 15s poussait le fan-out vers la deadline de 20s.
      timeout: 8000,
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
    case 'lulustream':
    case 'streamwish':
    case 'filelions':
      return await extractStreamWishFamily(embedUrl);
    case 'fsvid':
    case 'vidzy':
    case 'livavid':
    case 'vidoza':
      return await extractPackedJs(embedUrl);
    case 'mailru':
      return await extractMailru(embedUrl);
    case 'sibnet':
      return await extractSibnet(embedUrl);
    case 'vidmoly':
      return await extractVidmoly(embedUrl);
    default:
      return null;
  }
}

/**
 * Sibnet (video.sibnet.ru/shell.php?videoid=X) — host russe simple, non obfusqué.
 * La page expose directement le MP4 : `player.src([{src: "/v/{hash}/{id}.mp4" …`.
 * Le CDN exige un Referer (403 sinon) → on renvoie l'embed en Referer.
 */
async function extractSibnet(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const { data: page } = await axios.get<string>(embedUrl, {
      headers: { ...HEADERS, Referer: 'https://video.sibnet.ru/' },
      timeout: 15000,
      responseType: 'text',
      transformResponse: v => v,
    });
    const m = page.match(/player\.src\(\s*\[\s*\{\s*src:\s*["']([^"']+\.mp4[^"']*)["']/i)
      || page.match(/["'](\/v\/[a-z0-9]+\/\d+\.mp4[^"']*)["']/i);
    if (!m) {
      console.log('[Extractor] Sibnet: no mp4 in page');
      return null;
    }
    const rel = m[1];
    const url = rel.startsWith('http') ? rel : `https://video.sibnet.ru${rel.startsWith('/') ? '' : '/'}${rel}`;
    return { url, quality: 'HD', format: 'mp4', headers: { Referer: embedUrl } };
  } catch (e: any) {
    console.log(`[Extractor] Sibnet error: ${(e.message || '').slice(0, 80)}`);
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
  const LOCAL_ONLY: string[] = ['fsvid', 'vidzy', 'mailru', 'sibnet'];

  // Try MediaFlow first if configured
  if (config?.useMediaFlow && config.mediaFlowUrl && !LOCAL_ONLY.includes(extractor)) {
    const result = await extractViaMediaFlow(embedUrl, extractor, config);
    if (result) {
      return result;
    }
    console.log(`[Extractor] MediaFlow failed for ${extractor}, falling back to local`);
  }

  // Fall back to local extraction. Le drop des CDN anti-datacenter (403) est fait
  // en aval par applyMultiAudio (src/multiaudio.ts), via la sonde du master —
  // robuste à tout CDN (tnmr, acek-cdn…) sans liste figée.
  console.log(`[Extractor] Using local extractor for ${extractor}: ${embedUrl}`);
  return await extractLocally(embedUrl, extractor);
}

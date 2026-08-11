import { Router, Request, Response } from 'express';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { requireQueryKey, accessEnabled, accessKey } from './access';
import { autoWhitelistEnabled } from './settings';

const router = Router();

// ============================================
// SECURITY: Domain whitelist to prevent SSRF
// Loaded from config/allowed-domains.json
// ============================================
// Use relative path for local dev, /app/config for Docker
const CONFIG_PATH = process.env.DOMAINS_CONFIG ||
  (fs.existsSync('/app/config/allowed-domains.json')
    ? '/app/config/allowed-domains.json'
    : path.join(process.cwd(), 'config', 'allowed-domains.json'));
const DEFAULT_DOMAINS = [
  'net52.cc', 'nm-cdn', 'imgcdn.kim', 'freecdn4.top',
  'xalaflix.design', 'movix.blog',
  'streamflix.app', 'chilflix', 'streamflix.one',
  'akamaized.net', 'cloudfront.net', 'googleapis.com',
  // AnimeSama : lecteur ansembed + son CDN vmpx (sous-domaines rotatifs prx-*.vmpx.online).
  'ansembed.net', 'vmpx.online',
];

let ALLOWED_DOMAINS: string[] = [...DEFAULT_DOMAINS];

// Opt-in : quand une source renvoie un domaine non whitelisté, l'ajouter tout
// seul au lieu de bloquer le stream. Alternative au bot Telegram pour les
// self-hosters. ⚠️ Ne relâche QUE l'allowlist de domaines — le blocage des IP
// privées (protection SSRF critique) s'exécute avant et reste actif.
// L'état est lu à chaque usage via `autoWhitelistEnabled()` (réglages runtime :
// l'admin peut le basculer sans redémarrage — repli sur AUTO_WHITELIST du .env).
export { autoWhitelistEnabled };

/** Domaine enregistrable approximatif (2 derniers labels) — couvre les subdomains. */
function baseDomain(hostname: string): string {
  const parts = hostname.split('.');
  return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

/** Ajoute un domaine à l'allowlist (fichier + mémoire). Renvoie true si ajouté. */
export function addAllowedDomain(hostname: string): boolean {
  const domain = baseDomain(hostname.replace(/^\[|\]$/g, ''));
  if (ALLOWED_DOMAINS.some(d => hostname.includes(d) || hostname.endsWith(d))) return false;
  try {
    let config: any = { domains: [] };
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      config = { ...raw, domains: Array.isArray(raw.domains) ? raw.domains : [] };
    }
    if (!config.domains.includes(domain)) {
      config.domains.push(domain);
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    }
    if (!ALLOWED_DOMAINS.includes(domain)) ALLOWED_DOMAINS.push(domain);
    console.log(`[Proxy] Auto-whitelisted ${domain} (depuis ${hostname})`);
    return true;
  } catch (e: any) {
    console.error(`[Proxy] Auto-whitelist échoué pour ${domain}: ${e.message}`);
    return false;
  }
}

export function getAllowedDomains(): string[] { return [...ALLOWED_DOMAINS]; }

function loadAllowedDomains(): void {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(data);
      if (Array.isArray(config.domains)) {
        // Fusion : DEFAULT_DOMAINS (baseline codé, ex. CDN vmpx d'AnimeSama) TOUJOURS
        // présent, + les domaines du fichier. Sans ça, un fichier existant masquait
        // les défauts et un nouveau CDN codé en dur n'était jamais whitelisté.
        ALLOWED_DOMAINS = [...new Set([...DEFAULT_DOMAINS, ...config.domains])];
        console.log(`[Proxy] Loaded ${ALLOWED_DOMAINS.length} domains (défauts + config)`);
      }
    } else {
      console.log(`[Proxy] Config not found at ${CONFIG_PATH}, using defaults`);
    }
  } catch (e: any) {
    console.error(`[Proxy] Error loading config: ${e.message}, using defaults`);
  }
}

// Load on startup
loadAllowedDomains();

// Watch for config changes (hot-reload)
try {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.watch(CONFIG_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[Proxy] Config file changed, reloading...');
        setTimeout(loadAllowedDomains, 100); // Small delay to ensure file is fully written
      }
    });
  }
} catch (e) {
  // Watch not supported or file doesn't exist yet
}

// Private IP ranges to block (SSRF protection)
const PRIVATE_IP_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./, // Link-local / AWS metadata
  /^0\.0\.0\.0$/,
  /^\[::1\]$/,   // IPv6 localhost
  /^fc00:/i,     // IPv6 private
  /^fe80:/i,     // IPv6 link-local
];

export function isAllowedUrl(url: string): { allowed: boolean; reason?: string } {
  try {
    const parsed = new URL(url);

    // Only allow HTTP/HTTPS
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { allowed: false, reason: 'Invalid protocol' };
    }

    // Block private IPs
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(parsed.hostname)) {
        return { allowed: false, reason: 'Private IP not allowed' };
      }
    }

    // Check domain whitelist
    const isWhitelisted = ALLOWED_DOMAINS.some(domain =>
      parsed.hostname.includes(domain) || parsed.hostname.endsWith(domain)
    );

    if (!isWhitelisted) {
      // Pas d'auto-whitelist ICI : `url` est contrôlé par le client (proxy),
      // l'ajouter ouvrirait un proxy ouvert vers n'importe quel hôte public.
      // L'apprentissage AUTO_WHITELIST se fait côté serveur uniquement :
      // buildProxyUrl (domaine issu de NOTRE extraction) et rewriteManifest
      // (hôtes enfants d'un master déjà autorisé). Voir addAllowedDomain.
      return { allowed: false, reason: `Domain not whitelisted: ${parsed.hostname}` };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: 'Invalid URL format' };
  }
}

// Parse headers from query params (h_referer, h_user-agent, etc.)
// HTTP(S) + blocage IP privée, SANS exiger l'allowlist de domaines. Réservé aux endpoints
// qui NE relaient PAS de bande passante en masse (fixaudio : on ne sert que le manifeste
// maître, les segments restent en direct sur le CDN) -> l'allowlist (anti-proxy-ouvert de
// gros débit) n'est pas nécessaire ; la clé d'accès + le blocage IP privée suffisent.
function isSafePublicUrl(url: string): { allowed: boolean; reason?: string } {
  try {
    const p = new URL(url);
    if (!['http:', 'https:'].includes(p.protocol)) return { allowed: false, reason: 'Invalid protocol' };
    for (const pat of PRIVATE_IP_PATTERNS) if (pat.test(p.hostname)) return { allowed: false, reason: 'Private IP not allowed' };
    return { allowed: true };
  } catch { return { allowed: false, reason: 'Invalid URL format' }; }
}

function parseHeaders(query: Record<string, any>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('h_') && typeof value === 'string') {
      const headerName = key.slice(2); // Remove 'h_' prefix
      headers[headerName] = value;
    }
  }
  return headers;
}

// Get the base URL for rewriting manifest URLs
function getBaseUrl(req: Request): string {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Resolve a manifest-relative URL against the manifest's own URL. Uses the WHATWG
// URL resolver (handles absolute, path-relative and query-relative "?x=y" forms);
// falls back to the legacy base+concat only if that throws.
function resolveUrl(ref: string, originalUrl: string, originalBase: string): string {
  if (/^https?:\/\//i.test(ref)) return ref;
  try { return new URL(ref, originalUrl).href; } catch { return `${originalBase}${ref}`; }
}

// Rewrite URLs in HLS manifest to go through our proxy
// Promeut une piste audio en DEFAULT=YES/AUTOSELECT=YES si AUCUNE ne l'est déjà, sur un
// master à pistes audio séparées. Préfère le français (LANGUAGE fr*/NAME fran|vf), sinon
// la première piste (ordre source). Mute les lignes `lines` en place. No-op si une piste
// est déjà DEFAULT=YES ou s'il n'y a pas de #EXT-X-MEDIA:TYPE=AUDIO.
function ensureDefaultAudio(lines: string[]): void {
  const audioIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/i.test(t)) {
      if (/DEFAULT=YES/i.test(t)) return; // déjà un défaut -> ne touche à rien
      audioIdx.push(i);
    }
  }
  if (!audioIdx.length) return;
  const isFr = (l: string) =>
    /LANGUAGE="(fr|fre|fra)[^"]*"/i.test(l) || /NAME="[^"]*(fran|vff|vfq|\bvf\b)[^"]*"/i.test(l);
  const target = audioIdx.find(i => isFr(lines[i])) ?? audioIdx[0];
  let l = lines[target];
  l = /DEFAULT=NO/i.test(l) ? l.replace(/DEFAULT=NO/i, 'DEFAULT=YES') : (/DEFAULT=/i.test(l) ? l : l + ',DEFAULT=YES');
  l = /AUTOSELECT=NO/i.test(l) ? l.replace(/AUTOSELECT=NO/i, 'AUTOSELECT=YES') : (/AUTOSELECT=/i.test(l) ? l : l + ',AUTOSELECT=YES');
  lines[target] = l;
}

function rewriteManifest(
  manifest: string,
  originalUrl: string,
  baseUrl: string,
  headers: Record<string, string>,
  useTransformer: boolean,
  audioKeep?: string[] | null
): string {
  const originalBase = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);

  // AUTO_WHITELIST (côté serveur, sûr) : ce manifeste provient d'un master DÉJÀ
  // autorisé (le handler l'a validé). Les variantes/segments qu'il référence sont
  // donc légitimes — on apprend leur hôte pour survivre à une rotation de CDN de
  // segments sans intervention. Un client ne peut pas injecter ici : la chaîne
  // est enracinée sur un domaine autorisé.
  const learn = autoWhitelistEnabled()
    ? (u: string) => { try { addAllowedDomain(new URL(u).hostname); } catch { /* url invalide */ } }
    : (_u: string) => { /* no-op */ };

  // Build header query params
  const headerParams = Object.entries(headers)
    .map(([k, v]) => `h_${k.toLowerCase()}=${encodeURIComponent(v)}`)
    .join('&');

  // Clé d'accès : les segments/variantes réécrits sont rappelés par le player et
  // repassent par la garde /proxy — ils doivent donc porter `&k=` eux aussi.
  const keyParam = accessEnabled() ? `&k=${encodeURIComponent(accessKey()!)}` : '';

  let lines = manifest.split('\n');

  // Optional audio-rendition trim (master playlists). Some sources (NetMirror
  // netfree) expose 20+ audio tracks; players fetch EVERY rendition playlist
  // before playback starts, making startup painfully slow. Keep only the wanted
  // languages (by LANGUAGE prefix) plus the DEFAULT track (the original / VO).
  if (audioKeep && audioKeep.length && /#EXT-X-MEDIA:TYPE=AUDIO/.test(manifest)) {
    lines = lines.filter(line => {
      const t = line.trim();
      if (!t.startsWith('#EXT-X-MEDIA:') || !/TYPE=AUDIO/.test(t)) return true;
      if (/DEFAULT=YES/i.test(t)) return true; // always keep the original track
      const lang = (t.match(/LANGUAGE="([^"]+)"/i)?.[1] || '').toLowerCase();
      return audioKeep.some(k => lang.startsWith(k));
    });
  }

  // Garantie de son (systématique, tous providers). Beaucoup de masters à audio SÉPARÉ
  // (seekstreaming AES, purstream, anime…) ne marquent AUCUNE piste DEFAULT=YES — parfois
  // même AUTOSELECT=NO sur toutes. Les players stricts ne sélectionnent alors aucun audio
  // = VIDÉO SANS SON (Nuvio/ExoPlayer prend la 1re par tolérance, d'autres non). On promeut
  // une piste (français de préférence, sinon la 1re) en DEFAULT=YES/AUTOSELECT=YES.
  ensureDefaultAudio(lines);

  const rewritten = lines.map(line => {
    const trimmed = line.trim();

    // Skip empty lines and comments (except URI in EXT-X-KEY)
    if (!trimmed || (trimmed.startsWith('#') && !trimmed.includes('URI="'))) {
      return line;
    }

    // Handle any tag with URI="..." (EXT-X-KEY, EXT-X-MEDIA, etc.)
    if (trimmed.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        const fullUrl = resolveUrl(uri, originalUrl, originalBase);
        learn(fullUrl);

        // Check if it's a playlist (.m3u8) or a segment
        if (fullUrl.includes('.m3u8')) {
          const transformParam = useTransformer ? '&transformer=ts_stream' : '';
          return `URI="${baseUrl}/proxy/manifest?url=${encodeURIComponent(fullUrl)}&${headerParams}${transformParam}${keyParam}"`;
        } else {
          return `URI="${baseUrl}/proxy/segment?url=${encodeURIComponent(fullUrl)}&${headerParams}${keyParam}"`;
        }
      });
    }

    // Handle URLs (not comments)
    if (!trimmed.startsWith('#')) {
      // Resolve relative URLs correctly — including query-relative "?url=..."
      // (some workers self-proxy segments) which naive concat would mangle.
      const targetUrl = resolveUrl(trimmed, originalUrl, originalBase);
      learn(targetUrl);

      // Check if it's a playlist (.m3u8) or a segment
      if (targetUrl.includes('.m3u8')) {
        // It's a variant playlist - route through manifest proxy
        const transformParam = useTransformer ? '&transformer=ts_stream' : '';
        return `${baseUrl}/proxy/manifest?url=${encodeURIComponent(targetUrl)}&${headerParams}${transformParam}${keyParam}`;
      } else {
        // It's a segment - route through segment proxy
        const transformParam = useTransformer ? '&transform=ts' : '';
        return `${baseUrl}/proxy/segment?url=${encodeURIComponent(targetUrl)}&${headerParams}${transformParam}${keyParam}`;
      }
    }

    return line;
  });

  return rewritten.join('\n');
}

// Proxy HLS manifest
router.get('/manifest', requireQueryKey, async (req: Request, res: Response) => {
  const url = req.query.url as string;
  const transformer = req.query.transformer === 'ts_stream';
  const audioParam = (req.query.audio as string) || '';
  const audioKeep = audioParam
    ? audioParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : null;

  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  // SECURITY: Validate URL
  const validation = isAllowedUrl(url);
  if (!validation.allowed) {
    console.warn(`[Proxy] Blocked request: ${validation.reason} - ${url}`);
    return res.status(403).send(`Forbidden: ${validation.reason}`);
  }

  const headers = parseHeaders(req.query as Record<string, any>);
  const t0 = Date.now();
  let host = '?'; try { host = new URL(url).hostname; } catch { /* ignore */ }

  try {
    const response = await axios.get(url, {
      headers: {
        ...headers,
        'Accept': '*/*',
      },
      timeout: 10000,
      responseType: 'text',
    });

    const baseUrl = getBaseUrl(req);
    const rewritten = rewriteManifest(response.data, url, baseUrl, headers, transformer, audioKeep);
    console.log(`[Proxy] manifest ${host} ${Date.now() - t0}ms`);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store'); // manifeste réécrit + tokené -> jamais caché (évite un manifeste périmé côté player/CDN)
    res.send(rewritten);
  } catch (e: any) {
    console.error(`[Proxy] Manifest error:`, e.message);
    res.status(502).send('Failed to fetch manifest');
  }
});

// Master HLS « fixé » pour les flux livrés en DIRECT : injecte DEFAULT=YES sur une piste
// audio (ensureDefaultAudio) et résout les enfants (variantes/audio/segments) en URLs
// ABSOLUES CDN -> le player récupère TOUT le reste en direct (aucune bande passante segment
// chez nous). Corrige le « vidéo sans son » sur les masters multi-audio livrés en direct
// (seekstreaming, purstream…), là où un stream direct ne peut PAS être réécrit côté player.
router.get('/fixaudio', requireQueryKey, async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send('Missing url parameter');
  const validation = isSafePublicUrl(url);
  if (!validation.allowed) {
    console.warn(`[Proxy] fixaudio blocked: ${validation.reason} - ${url}`);
    return res.status(403).send(`Forbidden: ${validation.reason}`);
  }
  const headers = parseHeaders(req.query as Record<string, any>);
  try {
    const response = await axios.get(url, {
      headers: { ...headers, 'Accept': '*/*' }, timeout: 10000, responseType: 'text', transformResponse: r => r,
    });
    let text = String(response.data);
    if (!/#EXTM3U/.test(text)) return res.status(502).send('Not an HLS manifest');

    // Les enfants (variantes/segments) ne sont PAS servables en direct dans 2 cas :
    //   1) CDN HEADER-GATED : ils exigent Referer/Origin (ex. seekstreaming neocine.embedseek
    //      -> 403 sans headers). Un player fetchant une URL ABSOLUE ne peut PAS les envoyer.
    //   2) Segments DÉGUISÉS EN IMAGE (.png/.jpg = MPEG-TS, cf. NetMirror / purstream cdnvideo)
    //      -> le player reçoit du `image/png` qu'il ne décode pas.
    // Dans ces cas on délègue à rewriteManifest -> tout passe par le proxy LOCAL qui porte les
    // headers h_* (fetch côté serveur, plus de 403) et transforme les segments image en TS.
    // Sinon (CDN public + segments normaux) on garde la voie DIRECTE ci-dessous (BP nulle).
    const hasImageSegments = text.split('\n').some(l => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('#') && /\.(png|jpe?g)(\?|$)/i.test(t);
    });
    const headerGated = Object.keys(headers).some(k => /^(referer|origin)$/i.test(k));
    if (hasImageSegments || headerGated) {
      const rewritten = rewriteManifest(text, url, getBaseUrl(req), headers, hasImageSegments, null);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(rewritten);
    }

    const base = url.substring(0, url.lastIndexOf('/') + 1);
    let lines = text.split('\n');
    ensureDefaultAudio(lines);
    lines = lines.map(line => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return t.includes('URI="')
          ? line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${resolveUrl(u, url, base)}"`)
          : line;
      }
      return resolveUrl(t, url, base); // variante/audio -> URL absolue CDN (le player la lit en direct)
    });
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(lines.join('\n'));
  } catch (e: any) {
    console.error('[Proxy] fixaudio error:', e.message);
    res.status(502).send('Failed to fetch manifest');
  }
});

// Proxy segments (and transform .jpg to .ts if needed)
router.get('/segment', requireQueryKey, async (req: Request, res: Response) => {
  const url = req.query.url as string;
  const transform = req.query.transform === 'ts';

  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  // SECURITY: Validate URL
  const validation = isAllowedUrl(url);
  if (!validation.allowed) {
    console.warn(`[Proxy] Blocked segment: ${validation.reason} - ${url}`);
    return res.status(403).send(`Forbidden: ${validation.reason}`);
  }

  const headers = parseHeaders(req.query as Record<string, any>);
  const t0 = Date.now();
  let host = '?'; try { host = new URL(url).hostname; } catch { /* ignore */ }

  try {
    const response = await axios.get(url, {
      headers: {
        ...headers,
        'Accept': '*/*',
      },
      timeout: 30000,
      responseType: 'stream',
    });
    const ttfb = Date.now() - t0;

    // Content-type : forcer video/mp2t UNIQUEMENT sur les segments réellement déguisés
    // en TS (extension .jpg OU content-type image/* renvoyé par le CDN — NetMirror,
    // ancien Videasy). NE JAMAIS mislabeliser un fMP4 (.m4s / video/mp4, Videasy actuel)
    // en mp2t : le player casserait la vidéo (audio seul). On ne se fie donc PAS au flag
    // `transform` en aveugle, mais à la nature réelle du segment.
    let contentType = response.headers['content-type'];
    if (url.endsWith('.jpg') || /^image\//i.test(String(contentType || ''))) {
      contentType = 'video/mp2t';
    }

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    // Timing : révèle le pattern de fetch de Stremio (séquentiel/parallèle) et le
    // débit réel du CDN par segment — le goulot du démarrage. Seg de log = filename.
    let bytes = 0;
    const seg = url.split('/').pop()?.split('?')[0] || '';
    response.data.on('data', (c: Buffer) => { bytes += c.length; });
    response.data.on('end', () => {
      const ms = Date.now() - t0;
      const mbps = bytes > 0 && ms > 0 ? (bytes * 8 / ms / 1000).toFixed(1) : '0';
      console.log(`[Proxy] seg ${host} ${seg} ttfb=${ttfb}ms total=${ms}ms ${(bytes / 1e6).toFixed(1)}Mo ${mbps}Mbps`);
    });

    response.data.pipe(res);
  } catch (e: any) {
    console.error(`[Proxy] Segment error ${host} (${Date.now() - t0}ms):`, e.message);
    res.status(502).send('Failed to fetch segment');
  }
});

// Proxy direct stream (mkv, mp4, etc.) - passthrough without parsing
router.get('/stream', requireQueryKey, async (req: Request, res: Response) => {
  const url = req.query.url as string;

  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  // SECURITY: Validate URL
  const validation = isAllowedUrl(url);
  if (!validation.allowed) {
    console.warn(`[Proxy] Blocked stream: ${validation.reason} - ${url}`);
    return res.status(403).send(`Forbidden: ${validation.reason}`);
  }

  const headers = parseHeaders(req.query as Record<string, any>);

  try {
    console.log(`[Proxy] Streaming: ${url}`);

    // Forward Range header from client for seeking support
    const requestHeaders: Record<string, string> = {
      ...headers,
      'Accept': '*/*',
    };
    if (req.headers.range) {
      requestHeaders['Range'] = req.headers.range as string;
    }

    const response = await axios.get(url, {
      headers: requestHeaders,
      responseType: 'stream',
      timeout: 30000,
      // Don't throw on 206 Partial Content
      validateStatus: (status) => status >= 200 && status < 300 || status === 206,
    });

    // Set status code (200 or 206 for partial content)
    res.status(response.status);

    // Forward relevant headers
    const forwardHeaders = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
    for (const header of forwardHeaders) {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    response.data.pipe(res);
  } catch (e: any) {
    console.error(`[Proxy] Stream error:`, e.message);
    res.status(502).send('Failed to fetch stream');
  }
});

// Admin endpoint to reload config and view domains
router.get('/domains', (req: Request, res: Response) => {
  const reload = req.query.reload === 'true';
  if (reload) {
    loadAllowedDomains();
  }
  res.json({
    count: ALLOWED_DOMAINS.length,
    domains: ALLOWED_DOMAINS,
    configPath: CONFIG_PATH,
    reloaded: reload
  });
});

export default router;

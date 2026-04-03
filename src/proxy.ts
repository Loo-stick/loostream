import { Router, Request, Response } from 'express';
import axios from 'axios';

const router = Router();

// Parse headers from query params (h_referer, h_user-agent, etc.)
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

// Rewrite URLs in HLS manifest to go through our proxy
function rewriteManifest(
  manifest: string,
  originalUrl: string,
  baseUrl: string,
  headers: Record<string, string>,
  useTransformer: boolean
): string {
  const originalBase = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);

  // Build header query params
  const headerParams = Object.entries(headers)
    .map(([k, v]) => `h_${k.toLowerCase()}=${encodeURIComponent(v)}`)
    .join('&');

  const lines = manifest.split('\n');
  const rewritten = lines.map(line => {
    const trimmed = line.trim();

    // Skip empty lines and comments (except URI in EXT-X-KEY)
    if (!trimmed || (trimmed.startsWith('#') && !trimmed.includes('URI="'))) {
      return line;
    }

    // Handle any tag with URI="..." (EXT-X-KEY, EXT-X-MEDIA, etc.)
    if (trimmed.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        const fullUrl = uri.startsWith('http') ? uri : `${originalBase}${uri}`;

        // Check if it's a playlist (.m3u8) or a segment
        if (fullUrl.includes('.m3u8')) {
          const transformParam = useTransformer ? '&transformer=ts_stream' : '';
          return `URI="${baseUrl}/proxy/manifest?url=${encodeURIComponent(fullUrl)}&${headerParams}${transformParam}"`;
        } else {
          return `URI="${baseUrl}/proxy/segment?url=${encodeURIComponent(fullUrl)}&${headerParams}"`;
        }
      });
    }

    // Handle URLs (not comments)
    if (!trimmed.startsWith('#')) {
      let targetUrl = trimmed;

      // Make absolute URL
      if (!targetUrl.startsWith('http')) {
        targetUrl = `${originalBase}${targetUrl}`;
      }

      // Check if it's a playlist (.m3u8) or a segment
      if (targetUrl.includes('.m3u8')) {
        // It's a variant playlist - route through manifest proxy
        const transformParam = useTransformer ? '&transformer=ts_stream' : '';
        return `${baseUrl}/proxy/manifest?url=${encodeURIComponent(targetUrl)}&${headerParams}${transformParam}`;
      } else {
        // It's a segment - route through segment proxy
        const transformParam = useTransformer ? '&transform=ts' : '';
        return `${baseUrl}/proxy/segment?url=${encodeURIComponent(targetUrl)}&${headerParams}${transformParam}`;
      }
    }

    return line;
  });

  return rewritten.join('\n');
}

// Proxy HLS manifest
router.get('/manifest', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  const transformer = req.query.transformer === 'ts_stream';

  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  const headers = parseHeaders(req.query as Record<string, any>);

  try {
    console.log(`[Proxy] Fetching manifest: ${url}`);
    const response = await axios.get(url, {
      headers: {
        ...headers,
        'Accept': '*/*',
      },
      timeout: 10000,
      responseType: 'text',
    });

    const baseUrl = getBaseUrl(req);
    const rewritten = rewriteManifest(response.data, url, baseUrl, headers, transformer);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
  } catch (e: any) {
    console.error(`[Proxy] Manifest error:`, e.message);
    res.status(502).send('Failed to fetch manifest');
  }
});

// Proxy segments (and transform .jpg to .ts if needed)
router.get('/segment', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  const transform = req.query.transform === 'ts';

  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  const headers = parseHeaders(req.query as Record<string, any>);

  try {
    const response = await axios.get(url, {
      headers: {
        ...headers,
        'Accept': '*/*',
      },
      timeout: 30000,
      responseType: 'stream',
    });

    // Set content type (transform .jpg to .ts)
    let contentType = response.headers['content-type'];
    if (transform || url.endsWith('.jpg')) {
      contentType = 'video/mp2t';
    }

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);
  } catch (e: any) {
    console.error(`[Proxy] Segment error:`, e.message);
    res.status(502).send('Failed to fetch segment');
  }
});

// Proxy direct stream (mkv, mp4, etc.) - passthrough without parsing
router.get('/stream', async (req: Request, res: Response) => {
  const url = req.query.url as string;

  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  const headers = parseHeaders(req.query as Record<string, any>);

  try {
    console.log(`[Proxy] Streaming: ${url}`);

    const response = await axios.get(url, {
      headers: {
        ...headers,
        'Accept': '*/*',
      },
      responseType: 'stream',
      timeout: 30000,
    });

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

export default router;

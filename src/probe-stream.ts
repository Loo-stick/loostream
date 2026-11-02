// Sonde de jouabilité CÔTÉ SERVEUR d'un flux résolu (déclenchée manuellement depuis l'admin).
// Rejoue l'URL CDN avec ses headers d'extraction, descend d'un cran (master -> media) et
// récupère UN segment. Classe : vivant / mort (HTTP 4xx-5xx) / décoy (segment minuscule) /
// pas-un-flux. ATTENTION : fetch depuis l'IP SERVEUR -> attrape CDN mort, 403, 502, décoy ;
// ne voit PAS les soucis spécifiques au client (token lié IP, headers mal gérés par le player).
// Bornée : timeouts courts, 2 hops max, 1 seul segment -> charge négligeable, un appel/clic.

import axios from 'axios';
import * as https from 'https';

const INSECURE = new https.Agent({ rejectUnauthorized: false });
const TIMEOUT = 8000;
const DECOY_MAX = 600; // un « segment » sous ce seuil = leurre/mire, pas de la vraie vidéo

export type ProbeVerdict = 'alive' | 'dead' | 'decoy' | 'not_stream' | 'error';
export interface ProbeResult { verdict: ProbeVerdict; detail: string; }

function isHls(url: string, body?: string): boolean {
  return /\.m3u8(\?|$)/i.test(url) || (!!body && /#EXTM3U/i.test(body.slice(0, 64)));
}

async function get(url: string, headers: Record<string, string>, binary = false) {
  return axios.get(url, {
    headers, httpsAgent: INSECURE, timeout: TIMEOUT, maxRedirects: 4,
    responseType: binary ? 'arraybuffer' : 'text',
    transformResponse: (x: any) => x, validateStatus: () => true,
  });
}

// Descend une fois si `body` est un master (variante -> media playlist), renvoie {body,url}.
async function descendIfMaster(body: string, baseUrl: string, headers: Record<string, string>): Promise<{ body: string; url: string }> {
  if (/#EXTINF/i.test(body)) return { body, url: baseUrl }; // déjà une media playlist (a des segments)
  const variant = body.split('\n').find(l => l.trim() && !l.startsWith('#') && /\.m3u8/i.test(l));
  if (!variant) return { body, url: baseUrl };
  try {
    const abs = new URL(variant.trim(), baseUrl).toString();
    const r = await get(abs, headers);
    return { body: String(r.data || ''), url: abs };
  } catch { return { body, url: baseUrl }; }
}

export async function probeStream(url: string, headers: Record<string, string> = {}): Promise<ProbeResult> {
  try {
    const r = await get(url, headers);
    const body = String(r.data || '');
    if (r.status >= 400) return { verdict: 'dead', detail: `HTTP ${r.status}` };

    if (!isHls(url, body)) {
      // Fichier direct (mp4…) : un Range doit répondre 200/206 avec du binaire vidéo.
      const rng = await get(url, { ...headers, Range: 'bytes=0-65535' }, true);
      const n = Buffer.from(rng.data).length;
      if (rng.status >= 400) return { verdict: 'dead', detail: `HTTP ${rng.status}` };
      if (n < DECOY_MAX) return { verdict: 'decoy', detail: `${n} o seulement` };
      const ct = String(rng.headers['content-type'] || '');
      return { verdict: 'alive', detail: `${ct || 'binaire'} · ${n} o` };
    }

    // HLS : (master ->) media playlist -> 1er segment.
    const media = await descendIfMaster(body, url, headers);
    const segLine = media.body.split('\n').find(l => l.trim() && !l.startsWith('#') && /https?:|\.(ts|jpg|m4s|mp4)/i.test(l));
    if (!segLine) return { verdict: 'not_stream', detail: 'playlist sans segment' };
    const segUrl = new URL(segLine.trim(), media.url).toString();
    const seg = await get(segUrl, headers, true);
    if (seg.status >= 400) return { verdict: 'dead', detail: `segment HTTP ${seg.status}` };
    const n = Buffer.from(seg.data).length;
    if (n < DECOY_MAX) return { verdict: 'decoy', detail: `segment ${n} o (mire/leurre)` };
    return { verdict: 'alive', detail: `segment ${Math.round(n / 1024)} Ko` };
  } catch (e: any) {
    return { verdict: 'error', detail: e?.code || e?.message || 'erreur réseau' };
  }
}

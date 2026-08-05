import axios from 'axios';
import { cached } from './cache';
import { resLabel } from './multiaudio';

// Sonde la résolution d'un MP4 PROGRESSIF en lisant son conteneur (atomes
// moov → trak → tkhd), par requêtes HTTP Range BORNÉES — jamais le fichier entier.
// Complète la sonde HLS (multiaudio.probeMaster) pour les sources MP4 (StreamFlix)
// dont l'API ne donne qu'un 'HD' grossier. Renvoie un libellé ('1080p'…) ou null.
//
// tkhd porte width/height sur ses 8 DERNIERS octets (fixed-point 16.16), quelle que
// soit la version du box. Les pistes audio/soustitres ont height=0 → on prend le max.

const PROBE_TTL_MS = 15 * 60 * 1000;
const HEAD_BYTES = 256 * 1024;      // ftyp+moov d'un MP4 « faststart » (moov au début)
const MOOV_CAP = 2 * 1024 * 1024;   // plafond si le moov est en FIN de fichier
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

interface Box { size: number; headerLen: number; }
function readBoxHeader(buf: Buffer, o: number): Box | null {
  if (o + 8 > buf.length) return null;
  let size = buf.readUInt32BE(o);
  let headerLen = 8;
  if (size === 1) {                 // taille 64 bits (largesize)
    if (o + 16 > buf.length) return null;
    size = Number(buf.readBigUInt64BE(o + 8));
    headerLen = 16;
  }
  return { size, headerLen };
}

// Parcourt une zone de boxes, descend dans les conteneurs, remonte la hauteur max
// vue dans un tkhd. Borné en profondeur (anti-boucle sur fichier malformé).
function walk(buf: Buffer, start: number, end: number, out: { h: number }, depth = 0): void {
  let o = start;
  while (o + 8 <= end && depth < 8) {
    const b = readBoxHeader(buf, o);
    if (!b) break;
    let size = b.size;
    if (size === 0) size = end - o;           // s'étend jusqu'à la fin de la zone
    if (size < b.headerLen) break;
    const type = buf.toString('latin1', o + 4, o + 8);
    const pStart = o + b.headerLen;
    const pEnd = Math.min(o + size, end);
    if (type === 'tkhd') {
      if (pEnd - 4 >= pStart) {
        const h = buf.readUInt32BE(pEnd - 4) >>> 16; // height 16.16 -> partie entière
        if (h > out.h) out.h = h;
      }
    } else if (CONTAINERS.has(type)) {
      walk(buf, pStart, pEnd, out, depth + 1);
    }
    o += size;
  }
}

/** Hauteur vidéo (px) lue dans un buffer contenant le moov, ou null. Pur -> testable. */
export function mp4HeightFromBuffer(buf: Buffer): number | null {
  const out = { h: 0 };
  walk(buf, 0, buf.length, out);
  return out.h > 0 ? out.h : null;
}

// Offset du box qui SUIT les boîtes de tête (là où commence le moov s'il est en fin
// de fichier, après un gros mdat). 0 si indéterminable / dernier box jusqu'à EOF.
function offsetAfterHeadBoxes(buf: Buffer): number {
  let o = 0;
  while (o + 8 <= buf.length) {
    const b = readBoxHeader(buf, o);
    if (!b || b.size === 0 || b.size < b.headerLen) return 0;
    o += b.size;
  }
  return o;
}

async function fetchRange(url: string, headers: Record<string, string> | undefined, start: number, len: number): Promise<Buffer | null> {
  try {
    const resp = await axios.get<ArrayBuffer>(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', ...(headers || {}), Range: `bytes=${start}-${start + len - 1}` },
      timeout: 10000, responseType: 'arraybuffer',
      maxContentLength: len + 65536, maxBodyLength: len + 65536,
      validateStatus: s => s === 200 || s === 206, // 200 = serveur ignorant Range (début du fichier quand même)
    });
    return Buffer.from(resp.data);
  } catch {
    return null; // Range non supporté / trop gros / réseau : on garde le label d'origine
  }
}

/**
 * Sonde `url` (MP4 progressif) et renvoie un libellé de qualité ('1080p'…) ou null.
 * Caché 15 min (comme probeMaster). Deux fetchs Range max (tête, puis fin si le moov
 * n'est pas au début). Ne jette jamais : tout échec -> null (l'appelant garde 'HD').
 */
export async function probeMp4Quality(url: string, headers?: Record<string, string>): Promise<string | null> {
  return cached<string | null>(
    `mp4probe:${url}`,
    PROBE_TTL_MS,
    async () => {
      const head = await fetchRange(url, headers, 0, HEAD_BYTES);
      if (!head) return null;
      let height = mp4HeightFromBuffer(head);
      if (!height) {
        // moov probablement en fin de fichier (MP4 non-faststart) : sonder après ftyp+mdat.
        const off = offsetAfterHeadBoxes(head);
        if (off > head.length) {
          const tail = await fetchRange(url, headers, off, MOOV_CAP);
          if (tail) height = mp4HeightFromBuffer(tail);
        }
      }
      return height ? resLabel(height) : null;
    },
    { scope: 'mp4probe', shouldCache: r => r !== null }, // ne cache pas les échecs
  );
}

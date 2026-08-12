import axios from 'axios';
import { cached } from './cache';

// Résolution réelle d'un flux HLS QUAND le manifeste ne la déclare pas.
// Certains hôtes (sharecloudy/ofbax via Kordoz) servent une playlist MÉDIA à qualité
// unique (segments .ts directs, sans #EXT-X-STREAM-INF RESOLUTION) -> impossible de lire
// la qualité côté manifeste. On la lit alors à la source : le SPS H.264 du 1er segment TS
// porte la largeur/hauteur codées. On classe par la LARGEUR (le format cinéma letterbox
// donne une hauteur < 1080 pour une vraie image 1080p, ex. 1920x800).

const TTL_MS = 6 * 60 * 60 * 1000;
const REQ_TIMEOUT_MS = 12000;
const PROBE_BYTES = 300 * 1024; // assez pour capter un SPS (tout début du segment)

// Lecteur de bits pour l'Exp-Golomb du SPS.
class BitReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  bit(): number {
    const b = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  ue(): number {
    let zeros = 0;
    while (this.pos < this.bytes.length * 8 && this.bit() === 0) zeros++;
    let val = 0;
    for (let i = 0; i < zeros; i++) val = (val << 1) | this.bit();
    return (1 << zeros) - 1 + val;
  }
  se(): number {
    const k = this.ue();
    return (k & 1) ? (k + 1) >> 1 : -(k >> 1);
  }
  skipBits(n: number): void { this.pos += n; }
}

// Parse un SPS H.264 (sans l'octet de header NAL) -> {width, height} ou null.
// Couvre le cas courant (profils avec/sans chroma high, poc type 0/2, pas de scaling
// list) ; les cas rares renvoient null -> repli sur le libellé par défaut.
function parseSps(sps: Uint8Array): { width: number; height: number } | null {
  try {
    const profileIdc = sps[0];
    const r = new BitReader(sps);
    r.skipBits(24); // profile_idc(8) + constraints/reserved(8) + level_idc(8)
    r.ue();         // seq_parameter_set_id
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      const chroma = r.ue();
      if (chroma === 3) r.skipBits(1);
      r.ue(); // bit_depth_luma_minus8
      r.ue(); // bit_depth_chroma_minus8
      r.skipBits(1); // qpprime_y_zero_transform_bypass_flag
      if (r.bit() === 1) return null; // seq_scaling_matrix_present -> cas rare, on abandonne
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) {
      r.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      return null; // rare -> abandon
    }
    r.ue(); // max_num_ref_frames
    r.skipBits(1); // gaps_in_frame_num_value_allowed_flag
    const widthMbs = r.ue();
    const heightMap = r.ue();
    const frameMbsOnly = r.bit();
    if (frameMbsOnly === 0) r.skipBits(1); // mb_adaptive_frame_field_flag
    r.skipBits(1); // direct_8x8_inference_flag
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.bit() === 1) { // frame_cropping_flag
      cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue();
    }
    const width = (widthMbs + 1) * 16 - (cl + cr) * 2;
    const height = (2 - frameMbsOnly) * (heightMap + 1) * 16 - (ct + cb) * 2;
    if (width < 100 || width > 8000 || height < 100 || height > 5000) return null;
    return { width, height };
  } catch { return null; }
}

// Cherche le premier SPS (NAL type 7) dans le flux TS brut et le parse.
function resolutionFromTs(data: Buffer): { width: number; height: number } | null {
  for (let i = 0; i + 4 < data.length; i++) {
    // start code 00 00 01 puis octet NAL dont type (5 bits bas) == 7
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      const res = parseSps(data.subarray(i + 4, i + 4 + 40));
      if (res) return res;
    }
  }
  return null;
}

function classify(width: number, height: number): string {
  const w = Math.max(width, Math.round(height * 16 / 9)); // normalise via la largeur (letterbox)
  if (w >= 3400 || height >= 1800) return '2160p';
  if (w >= 1800 || height >= 1000) return '1080p';
  if (w >= 1200 || height >= 680) return '720p';
  return '480p';
}

async function fetchBuf(url: string, headers: Record<string, string>, range?: string): Promise<Buffer | null> {
  try {
    const { data, status } = await axios.get<ArrayBuffer>(url, {
      headers: range ? { ...headers, Range: range } : headers,
      timeout: REQ_TIMEOUT_MS, responseType: 'arraybuffer',
      validateStatus: () => true, maxRedirects: 4,
    });
    if (status < 200 || status >= 400) return null;
    return Buffer.from(data);
  } catch { return null; }
}

// Résolution réelle d'un MP4 (progressif, ex. streamtape résolu via MediaFlow) : la box
// `avc1`/`hvc1`/`hev1` (VisualSampleEntry, dans stsd) porte width/height en 16-bit BE à
// +28/+30 du type. Les MP4 de streaming sont faststart (moov en tête) -> un range du début
// suffit. Renvoie un libellé ('2160p'|…) ou null. Caché par URL.
export async function probeMp4Resolution(url: string, headers: Record<string, string> = {}): Promise<string | null> {
  return cached<string | null>(
    `mp4res:${url}`, TTL_MS,
    async () => {
      const buf = await fetchBuf(url, headers, `bytes=0-${PROBE_BYTES * 5 - 1}`); // ~1.5 Mo : capte le moov
      if (!buf) return null;
      const stsd = buf.indexOf('stsd', 0, 'latin1');
      if (stsd < 0) return null;
      let a = -1;
      for (const tag of ['avc1', 'hvc1', 'hev1', 'mp4v']) {
        const i = buf.indexOf(tag, stsd, 'latin1');
        if (i >= 0) { a = i; break; }
      }
      if (a < 0 || a + 32 > buf.length) return null;
      const width = buf.readUInt16BE(a + 28);
      const height = buf.readUInt16BE(a + 30);
      if (width < 100 || width > 8000 || height < 100 || height > 5000) return null;
      return classify(width, height);
    },
    { scope: 'mp4res', shouldCache: r => !!r }
  );
}

export interface HlsProbe {
  quality: string | null; // '2160p'|'1080p'|'720p'|'480p' ou null si indéterminable
  dead: boolean;          // true si le manifeste est définitivement absent (404/410/403)
}

/**
 * Sonde un HLS (playlist média mono-qualité) : liveness du manifeste + résolution réelle
 * via le SPS du 1er segment TS. Sert à la fois à écarter les flux morts et à afficher la
 * vraie qualité. Caché (SQLite) par URL de manifeste.
 */
export async function probeHlsResolution(m3u8Url: string, headers: Record<string, string> = {}): Promise<HlsProbe> {
  return cached<HlsProbe>(
    `hlsres:${m3u8Url}`, TTL_MS,
    async () => {
      let status = 0, text = '';
      try {
        const resp = await axios.get<string>(m3u8Url, {
          headers, timeout: REQ_TIMEOUT_MS, responseType: 'text', transformResponse: v => v,
          validateStatus: () => true, maxRedirects: 4,
        });
        status = resp.status;
        if (typeof resp.data === 'string') text = resp.data;
      } catch { return { quality: null, dead: false }; } // erreur réseau -> on ne punit pas (transitoire)
      // 404/410/403 = fichier absent côté CDN -> flux mort, à écarter.
      if ([403, 404, 410].includes(status)) return { quality: null, dead: true };
      if (status < 200 || status >= 400 || !text) return { quality: null, dead: false };
      // Master (déjà des RESOLUTION) -> on laisse le pipeline habituel gérer.
      if (/#EXT-X-STREAM-INF/i.test(text)) return { quality: null, dead: false };
      const seg = text.split(/\r?\n/).find(l => l && !l.startsWith('#'));
      if (!seg) return { quality: null, dead: false };
      const segUrl = /^https?:\/\//i.test(seg) ? seg : `${m3u8Url.replace(/\/[^/]*$/, '')}/${seg}`;
      const ts = await fetchBuf(segUrl, headers, `bytes=0-${PROBE_BYTES - 1}`);
      if (!ts || ts[0] !== 0x47) return { quality: null, dead: false }; // pas un flux TS
      const res = resolutionFromTs(ts);
      return { quality: res ? classify(res.width, res.height) : null, dead: false };
    },
    { scope: 'hlsres', shouldCache: () => true }
  );
}

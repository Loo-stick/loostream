// Santé des extracteurs ET des sources, dérivée du TRAFIC RÉEL (pas de test synthétique).
// Deux hooks :
//  - recordExtraction(id, url, headers) : à l'EXTRACTION réussie — l'extracteur est connu de
//    façon FIABLE (son id), et le flux résolu + headers servent d'ÉCHANTILLON re-sondable.
//    (Indispensable : le CDN résolu ne porte souvent PAS le nom de l'extracteur — filelions ->
//    premilkyway, lulustream -> tnmr… -> on ne peut PAS le retrouver depuis l'URL livrée.)
//  - recordDelivery(url, mode, source, headers) : à la LIVRAISON — on connaît le MODE et la
//    SOURCE. On incrémente le mode de la source (toujours) et de l'extracteur SI son CDN est
//    reconnaissable (best-effort, ex. uqload/vidzy). En mémoire, remis à zéro au redémarrage.

import { detectExtractor } from './extractors';

export type DeliveryMode = 'direct' | 'local' | 'mediaflow';

interface Sample { url: string; headers: Record<string, string>; }
interface Health {
  seen: number;
  lastSeen: number;
  modes: Record<DeliveryMode, number>;
  sample?: Sample;
}

const extractors: Record<string, Health> = {};
const sources: Record<string, Health> = {};

// Apprentissage CDN-résolu -> extracteur, alimenté à l'EXTRACTION (id fiable). Permet
// d'attribuer un extracteur à une livraison SERVIE DEPUIS LE CACHE (extractStream non rappelé)
// alors que le CDN ne porte pas le nom de l'extracteur (filelions -> premilkyway.com). Clé =
// domaine de base (2 derniers labels) car le sous-domaine tourne (g6m5vwc8rl.premilkyway.com).
const cdnToExtractor: Record<string, string> = {};
function baseDomain(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const p = h.split('.');
    return p.length >= 2 ? p.slice(-2).join('.') : h;
  } catch { return null; }
}

function init(): Health { return { seen: 0, lastSeen: 0, modes: { direct: 0, local: 0, mediaflow: 0 } }; }

function originalUrl(deliveredUrl: string): string {
  try {
    const u = new URL(deliveredUrl);
    return u.searchParams.get('url') || u.searchParams.get('d') || deliveredUrl;
  } catch { return deliveredUrl; }
}

function extractHeaders(deliveredUrl: string, proxyHeaders?: Record<string, string>): Record<string, string> {
  if (proxyHeaders && Object.keys(proxyHeaders).length) return { ...proxyHeaders };
  const h: Record<string, string> = {};
  try {
    new URL(deliveredUrl).searchParams.forEach((v, k) => { if (k.startsWith('h_')) h[k.slice(2)] = v; });
  } catch { /* rien */ }
  return h;
}

// Extraction réussie : id fiable, échantillon = flux résolu + headers d'extraction.
export function recordExtraction(id: string, resolvedUrl: string, headers?: Record<string, string>): void {
  const h = extractors[id] || (extractors[id] = init());
  h.seen++;
  h.lastSeen = Date.now();
  if (resolvedUrl) {
    h.sample = { url: resolvedUrl, headers: headers || {} };
    const bd = baseDomain(resolvedUrl);
    if (bd) cdnToExtractor[bd] = id; // apprend le CDN pour attribuer les livraisons en cache
  }
}

// Flux livré : mode + source connus. Mode de l'extracteur en best-effort (CDN reconnaissable).
export function recordDelivery(deliveredUrl: string, mode: DeliveryMode, source?: string, proxyHeaders?: Record<string, string>): void {
  const orig = originalUrl(deliveredUrl);
  const sample: Sample = { url: orig, headers: extractHeaders(deliveredUrl, proxyHeaders) };
  if (source) {
    const h = sources[source] || (sources[source] = init());
    h.seen++; h.lastSeen = Date.now(); h.modes[mode] = (h.modes[mode] || 0) + 1; h.sample = sample;
  }
  // Extracteur : détection directe sur le CDN, sinon repli sur le CDN appris à l'extraction.
  let id: string | null = detectExtractor(orig);
  if (!id) { const bd = baseDomain(orig); id = (bd && cdnToExtractor[bd]) || null; }
  if (id) {
    const h = extractors[id] || (extractors[id] = init());
    h.lastSeen = Date.now(); h.modes[mode] = (h.modes[mode] || 0) + 1;
    if (!h.sample) h.sample = sample;
  }
}

interface HealthView { seen: number; lastSeen: number | null; modes: Record<DeliveryMode, number>; hasSample: boolean; }
function view(map: Record<string, Health>): Record<string, HealthView> {
  const out: Record<string, HealthView> = {};
  for (const [k, h] of Object.entries(map)) {
    out[k] = { seen: h.seen, lastSeen: h.lastSeen || null, modes: h.modes, hasSample: !!h.sample };
  }
  return out;
}
export function getExtractorHealth(): Record<string, HealthView> { return view(extractors); }
export function getSourceHealth(): Record<string, HealthView> { return view(sources); }

export function getExtractorSample(id: string): Sample | undefined { return extractors[id]?.sample; }
export function getSourceSample(name: string): Sample | undefined { return sources[name]?.sample; }

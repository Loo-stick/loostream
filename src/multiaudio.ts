import axios from 'axios';
import { cached } from './cache';

// Sonde du master HLS, deux usages en UN seul fetch (caché) :
//   1. RELABEL MULTI : ≥2 pistes EXT-X-MEDIA:TYPE=AUDIO de langues distinctes.
//   2. DROP des CDN anti-datacenter : certains CDN (tnmr.org, acek-cdn.com…)
//      renvoient 403 aux IP serveur — jouables seulement depuis une IP
//      résidentielle. Inutile de proposer un stream qui ne lira jamais.
//
// Sûreté : on n'agit que sur info DIRECTE. 403/401/451 = blocage confirmé ->
// drop (mis en cache). Timeout/5xx/réseau = incertain -> on garde le stream et
// le label d'origine (pas de faux négatif sur une panne passagère).

const PROBE_TIMEOUT_MS = 6000;
const PROBE_TTL_MS = 15 * 60 * 1000; // aligné sur le cache des scrapers

const BLOCKED = -403; // sentinelle : CDN qui refuse les IP serveur
const UNKNOWN = -1;    // erreur passagère : ne pas cacher, ne rien changer

// Résultat de sonde : nb de langues audio (>=0), BLOCKED (-403) ou UNKNOWN (-1).
async function probeMaster(url: string, headers?: Record<string, string>): Promise<number> {
  return cached<number>(
    `multiaudio:${url}`,
    PROBE_TTL_MS,
    async () => {
      try {
        const resp = await axios.get<string>(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', ...(headers || {}) },
          timeout: PROBE_TIMEOUT_MS,
          responseType: 'text',
          transformResponse: r => r,
          validateStatus: () => true,
          maxRedirects: 3,
        });
        if ([401, 403, 451].includes(resp.status)) return BLOCKED; // anti-datacenter confirmé
        if (resp.status < 200 || resp.status >= 400) return UNKNOWN; // 5xx/4xx divers : incertain
        const langs = new Set(
          [...String(resp.data).matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*?LANGUAGE="([^"]+)"/gi)]
            .map(m => m[1].toLowerCase().trim())
            .filter(Boolean)
        );
        return langs.size;
      } catch {
        return UNKNOWN; // timeout/réseau : passager
      }
    },
    { scope: 'multiaudio', shouldCache: n => n >= 0 || n === BLOCKED } // ne cache pas l'incertain
  );
}

interface Labellable {
  url: string;
  language: string;
  headers?: Record<string, string>;
}

// Un flux MediaFlow ressemble à `…/manifest.m3u8?d=<CDN brut>&h_referer=…`. On sonde
// alors le CDN BRUT directement (pas via MediaFlow : plus rapide, aucune charge ni
// timeout 502 sur l'instance). En extraction locale, l'URL EST déjà le CDN brut.
export function probeTarget(url: string, headers?: Record<string, string>): { url: string; headers?: Record<string, string>; viaMediaFlow: boolean } {
  try {
    const u = new URL(url);
    const d = u.searchParams.get('d');
    if (d && /^https?:\/\//.test(d)) {
      const ref = u.searchParams.get('h_referer') || u.searchParams.get('h_Referer');
      return { url: d, headers: ref ? { Referer: ref } : headers, viaMediaFlow: true };
    }
  } catch { /* URL non parsable : sondée telle quelle */ }
  return { url, headers, viaMediaFlow: false };
}

/**
 * Pour une liste de streams : écarte les HLS dont le CDN bloque les IP serveur
 * (403 confirmé) et relabelle en MULTI ceux à ≥2 langues audio. Renvoie la liste
 * filtrée. Les non-HLS et les sondes incertaines passent inchangés.
 *
 * Optimisation : on sonde toujours le CDN BRUT (jamais via MediaFlow). Le drop
 * 403 ne s'applique qu'aux URLs BRUTES (mode local) : en mode MediaFlow, c'est
 * MediaFlow qui livre (autre IP), on ne préjuge pas de sa capacité — on garde.
 */
export async function applyMultiAudio<T extends Labellable>(streams: T[]): Promise<T[]> {
  const kept = await Promise.all(streams.map(async s => {
    if (!/\.m3u8(\?|$)/i.test(s.url)) return s;           // non-HLS : tel quel
    const t = probeTarget(s.url, s.headers);
    const n = await probeMaster(t.url, t.headers);
    if (n === BLOCKED && !t.viaMediaFlow) return null;    // CDN 403 en local -> drop
    if (n >= 2 && !/multi/i.test(s.language)) s.language = 'MULTI'; // upgrade sur confirmation
    return s;                                              // UNKNOWN ou mono : inchangé
  }));
  return kept.filter(s => s !== null) as T[];
}

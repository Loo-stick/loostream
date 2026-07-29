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

/**
 * Pour une liste de streams : écarte les HLS dont le CDN bloque les IP serveur
 * (403 confirmé) et relabelle en MULTI ceux à ≥2 langues audio. Renvoie la liste
 * filtrée. Les non-HLS et les sondes incertaines passent inchangés.
 */
export async function applyMultiAudio<T extends Labellable>(streams: T[]): Promise<T[]> {
  const kept = await Promise.all(streams.map(async s => {
    if (!/\.m3u8(\?|$)/i.test(s.url)) return s;           // non-HLS : tel quel
    const n = await probeMaster(s.url, s.headers);
    if (n === BLOCKED) return null;                        // CDN injoignable serveur -> drop
    if (n >= 2 && !/multi/i.test(s.language)) s.language = 'MULTI'; // upgrade sur confirmation
    return s;                                              // UNKNOWN ou mono : inchangé
  }));
  return kept.filter(s => s !== null) as T[];
}

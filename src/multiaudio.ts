import axios from 'axios';
import { cached } from './cache';

// Sonde du master HLS, deux usages en UN seul fetch (caché) :
//   1. RELABEL MULTI : ≥2 pistes EXT-X-MEDIA:TYPE=AUDIO de langues distinctes.
//   2. DROP des CDN anti-datacenter : certains CDN (tnmr.org, acek-cdn.com…)
//      renvoient 403 aux IP serveur — jouables seulement depuis une IP
//      résidentielle. Inutile de proposer un stream qui ne lira jamais.
//
// Sûreté : on n'agit que sur info DIRECTE. 403/401/451 = blocage confirmé ->
// drop (mis en cache). 404/410 = playlist absente -> lien mort, drop aussi : le lien
// a été produit par CE serveur, mort vu d'ici il l'est pour tout le monde (vérifié
// 2026-09-14 : un lulustream de Monte-Cristo proposé en « HD » rendait 404).
// Timeout/5xx/réseau = incertain -> on garde le stream et le label d'origine (pas de
// faux négatif sur une panne passagère).

const PROBE_TIMEOUT_MS = 6000;
const PROBE_TTL_MS = 15 * 60 * 1000; // aligné sur le cache des scrapers

const BLOCKED = -403; // sentinelle : CDN qui refuse les IP serveur
const DEAD = -404;    // sentinelle : playlist absente (404/410) = lien mort
const UNKNOWN = -1;    // erreur passagère : ne pas cacher, ne rien changer

// Résultat de sonde EN UN SEUL fetch : nb de langues audio (langs >=0, ou BLOCKED/DEAD
// /UNKNOWN) + dimensions de la meilleure variante (résolution réelle, ou null).
interface Probe { langs: number; height: number | null; width?: number | null; }
export async function probeMaster(url: string, headers?: Record<string, string>): Promise<Probe> {
  return cached<Probe>(
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
        if ([401, 403, 451].includes(resp.status)) return { langs: BLOCKED, height: null }; // anti-datacenter confirmé
        if ([404, 410].includes(resp.status)) return { langs: DEAD, height: null };        // lien mort
        if (resp.status < 200 || resp.status >= 400) return { langs: UNKNOWN, height: null }; // divers : incertain
        const body = String(resp.data);
        const langs = new Set(
          [...body.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*?LANGUAGE="([^"]+)"/gi)]
            .map(m => m[1].toLowerCase().trim())
            .filter(Boolean)
        );
        // RESOLUTION=WxH de toutes les variantes -> la MEILLEURE (hauteur effective max, qui
        // tient compte de la largeur : un 1920x960 cinémascope est un 1080p, pas un 720p).
        let best: { w: number; h: number } | null = null;
        for (const m of body.matchAll(/RESOLUTION=(\d+)x(\d+)/gi)) {
          const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
          if (!(h > 0)) continue;
          if (!best || effectiveHeight(h, w) > effectiveHeight(best.h, best.w)) best = { w, h };
        }
        return { langs: langs.size, height: best ? best.h : null, width: best ? best.w : null };
      } catch {
        return { langs: UNKNOWN, height: null }; // timeout/réseau : passager
      }
    },
    { scope: 'multiaudio', shouldCache: r => r.langs >= 0 || r.langs === BLOCKED || r.langs === DEAD } // ne cache pas l'incertain
  );
}

// Hauteur « effective » : un film au format cinémascope garde la LARGEUR de sa classe
// mais perd de la hauteur (bandes noires retirées) — 1920x960 est un 1080p, 1280x640 un
// 720p. On ramène donc la largeur à une hauteur 16:9 et on garde la plus grande des deux.
// Sans largeur connue, c'est la hauteur telle quelle (comportement d'avant).
export function effectiveHeight(h: number, w?: number | null): number {
  return Math.max(h, w && w > 0 ? Math.round(w * 9 / 16) : 0);
}

// Meilleure variante -> libellé de qualité (affichage + tri). Remplace le générique 'HD'
// des extracteurs par la vraie résolution lue dans le manifest.
// Exporté : réutilisé par la sonde MP4 (src/mp4probe.ts) pour les sources non-HLS.
export function resLabel(height: number, width?: number | null): string | null {
  const h = effectiveHeight(height, width);
  if (h >= 1400) return '4K';
  if (h >= 1000) return '1080p';
  if (h >= 650) return '720p';
  if (h >= 520) return '576p';
  if (h >= 340) return '480p';
  if (h >= 200) return '360p';
  return null;
}

interface Labellable {
  url: string;
  language: string;
  quality?: string;
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
// Hôtes dont le CDN throttle (rate/IP) et renvoie 403 par intermittence — PAS un blocage
// datacenter permanent. On ne les écarte pas sur un 403 de sonde (faux positif).
function isTrollHost(url: string): boolean {
  try { return /vidzy|fsvid/i.test(new URL(url).hostname); } catch { return false; }
}

export async function applyMultiAudio<T extends Labellable>(streams: T[]): Promise<T[]> {
  const t0 = Date.now();
  let probed = 0;
  const kept = await Promise.all(streams.map(async s => {
    if (!/\.m3u8(\?|$)/i.test(s.url)) return s;           // non-HLS : tel quel
    const t = probeTarget(s.url, s.headers);
    const { langs, height, width } = await probeMaster(t.url, t.headers);
    probed++;
    // CDN 403 sur la sonde serveur -> drop, SAUF hôtes-troll (vidzy/fsvid) : leur 403 est un
    // throttle rate/IP TRANSITOIRE (pas un blocage datacenter permanent). Les jeter privait le
    // user de flux jouables — en direct le CLIENT fetch (sonde serveur hors-sujet), en local le
    // proxy les sert avec IFRAME_HEADERS + retries. Sans cette exemption : "No streams found"
    // intermittent sur les titres servis UNIQUEMENT par vidzy/fsvid (ex. The Shards).
    if (langs === BLOCKED && !t.viaMediaFlow && !isTrollHost(t.url)) return null;
    // Playlist absente (404/410) : lien mort, inutile de le proposer. Hôtes-troll exemptés
    // par prudence (leurs refus sont transitoires).
    if (langs === DEAD && !isTrollHost(t.url)) return null;
    if (langs >= 2 && !/multi/i.test(s.language)) s.language = 'MULTI'; // upgrade sur confirmation
    // Qualité RÉELLE : le master est déjà téléchargé -> on remplace le 'HD' générique
    // par la résolution mesurée (coût ~0, juste un regex). Zéro fetch en plus.
    if (height && s.quality !== undefined) {
      const lbl = resLabel(height, width);
      if (lbl) s.quality = lbl;
    }
    return s;                                              // UNKNOWN ou mono : label inchangé
  }));
  const out = kept.filter(s => s !== null) as T[];
  if (probed) console.log(`[MultiAudio] ${probed} master(s) sondé(s) en ${Date.now() - t0}ms (résolution + langues)`);
  return out;
}

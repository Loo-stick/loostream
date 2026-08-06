import axios from 'axios';
import { cached } from './cache';

// Sous-titres FR externes via l'API LEGACY d'OpenSubtitles (rest.opensubtitles.org) :
// sans clé, sans quota, liens de téléchargement directs (SRT gzippé). Complète les
// sources VO (Videasy) qui ne portent pas de FR. Servi ensuite via /extsub/subtitle.

const OS_BASE = 'https://rest.opensubtitles.org';
const OS_UA = 'LooStream/1.0 (+subtitles)'; // l'API legacy exige un User-Agent
const TTL_MS = 12 * 60 * 60 * 1000;
const TOP_N = 5;

export interface ExtSub { url: string; name: string; downloads: number }

/** Pur : filtre srt/ass/ssa, mappe, trie par téléchargements décroissants, top N.
 * L'anime est quasi toujours en .ass (SubStation Alpha) -> on l'accepte (converti
 * en VTT à la livraison, cf. subtitleToVtt). SubFormat peut être vide : on retombe
 * sur l'extension du nom de fichier. */
export function parseOpenSubtitles(data: any[]): ExtSub[] {
  if (!Array.isArray(data)) return [];
  const isTextSub = (s: any) => {
    const fmt = String(s?.SubFormat || '');
    const name = String(s?.SubFileName || '');
    return /(srt|ass|ssa|vtt)/i.test(fmt) || /\.(srt|ass|ssa|vtt)$/i.test(name);
  };
  return data
    .filter(s => s?.SubDownloadLink && isTextSub(s))
    .map(s => ({
      url: String(s.SubDownloadLink),
      name: String(s.SubFileName || s.MovieReleaseName || 'OpenSubtitles'),
      downloads: Number(s.SubDownloadsCnt) || 0,
    }))
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, TOP_N);
}

export async function getFrenchSubtitles(imdbId: string, season?: number, episode?: number): Promise<ExtSub[]> {
  const num = String(imdbId || '').replace(/^tt/i, '');
  if (!/^\d+$/.test(num)) return [];
  const path = (season && episode)
    ? `/search/episode-${episode}/imdbid-${num}/season-${season}/sublanguageid-fre`
    : `/search/imdbid-${num}/sublanguageid-fre`;
  return cached<ExtSub[]>(
    `extsub:fre:${num}:${season || ''}:${episode || ''}`,
    TTL_MS,
    async () => {
      try {
        const { data } = await axios.get(`${OS_BASE}${path}`, { headers: { 'User-Agent': OS_UA }, timeout: 12000 });
        return parseOpenSubtitles(data);
      } catch { return []; }
    },
    { scope: 'extsub', shouldCache: r => r.length > 0 },
  );
}

/** Timecode ASS (`H:MM:SS.cc`, centisecondes) -> VTT (`HH:MM:SS.mmm`). */
function assTime(t: string): string | null {
  const m = String(t || '').trim().match(/^(\d+):(\d{2}):(\d{2})[.,](\d{2})$/);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${m[4]}0`; // cc -> mmm
}

/**
 * ASS/SSA -> VTT. Garde le TEXTE des dialogues (lisible), jette le stylage (pos,
 * karaoké, fontes) que le player ne rend pas. On lit le `Format:` de `[Events]`
 * pour localiser Start/End/Text, puis on nettoie les balises override `{\…}`, les
 * sauts `\N`/`\n` et les espaces `\h`.
 */
export function assToVtt(ass: string): string {
  const lines = ass.split(/\r?\n/);
  let format: string[] | null = null;
  let inEvents = false;
  const cues: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) { inEvents = /^\[events\]$/i.test(trimmed); continue; }
    if (!inEvents) continue;
    if (/^Format:/i.test(trimmed)) {
      format = trimmed.replace(/^Format:\s*/i, '').split(',').map(s => s.trim().toLowerCase());
      continue;
    }
    if (/^Dialogue:/i.test(trimmed) && format) {
      const startIdx = format.indexOf('start');
      const endIdx = format.indexOf('end');
      const textIdx = format.indexOf('text');
      if (startIdx < 0 || endIdx < 0 || textIdx < 0) continue;
      const parts = trimmed.replace(/^Dialogue:\s*/i, '').split(',');
      const start = assTime(parts[startIdx]);
      const end = assTime(parts[endIdx]);
      if (!start || !end) continue;
      // 'Text' est le dernier champ ASS -> rejoindre pour ne pas perdre ses virgules.
      const text = parts.slice(textIdx).join(',')
        .replace(/\{[^}]*\}/g, '')   // balises override
        .replace(/\\[nN]/g, '\n')    // \N (dur) et \n (doux) -> saut de ligne
        .replace(/\\h/gi, ' ')       // espace insécable ASS
        .trim();
      if (text) cues.push(`${start} --> ${end}\n${text}`);
    }
  }
  return 'WEBVTT\n\n' + cues.join('\n\n') + (cues.length ? '\n' : '');
}

/** SRT -> VTT : virgule décimale -> point, normalise les flèches. */
export function srtToVtt(srt: string): string {
  return 'WEBVTT\n\n' + srt
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/[ \t]*-->[ \t]*/g, ' --> ');
}

/** Détecte le format (VTT tel quel / ASS / sinon SRT) et renvoie du VTT. */
export function subtitleToVtt(raw: string): string {
  const s = raw.replace(/\r+/g, '').replace(/^﻿/, '');
  if (/^\s*WEBVTT/.test(s)) return s; // déjà du VTT
  if (/^\s*\[Script Info\]/im.test(s) || /^\s*Dialogue:\s/im.test(s)) return assToVtt(s);
  return srtToVtt(s);
}

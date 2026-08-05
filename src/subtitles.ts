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

/** Pur : filtre srt, mappe, trie par téléchargements décroissants, top N. */
export function parseOpenSubtitles(data: any[]): ExtSub[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter(s => s?.SubDownloadLink && /srt/i.test(String(s.SubFormat || '')))
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

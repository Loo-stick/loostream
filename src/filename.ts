import axios from 'axios';
import { cached } from './cache';

// AIOStreams (and other meta-addons) parse behaviorHints.filename with
// @viren070/parse-torrent-title to extract title/year/S-E/resolution/lang.
// Without a filename, our streams get dropped at the "basic filters" stage.
// We build a scene-style filename for every stream here.

const CINEMETA_TTL_MS = 6 * 60 * 60 * 1000; // >= 1h per spec
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

interface SceneMeta {
  title: string;
  year: string;
}

// English/scene title + year from Cinemeta, keyed by imdb id. Cached (SQLite).
async function getCinemetaMeta(type: 'movie' | 'series', imdbId: string): Promise<SceneMeta | null> {
  return cached<SceneMeta | null>(
    `cinemeta:${type}:${imdbId}`,
    CINEMETA_TTL_MS,
    async () => {
      try {
        const { data } = await axios.get(`${CINEMETA_BASE}/meta/${type}/${imdbId}.json`, { timeout: 10000 });
        const meta = data?.meta;
        if (!meta?.name) return null;
        const year = String(meta.year || meta.releaseInfo || '').match(/\d{4}/)?.[0] || '';
        return { title: String(meta.name), year };
      } catch {
        return null;
      }
    },
    { scope: 'cinemeta', shouldCache: r => !!r }
  );
}

/**
 * Resolve the title+year to use in the filename. Prefer Cinemeta (English/scene
 * title) over the source-derived title, which is often FR/translated. Falls back
 * to the TMDB-derived info when Cinemeta is unavailable (e.g. tmdb: ids).
 */
export async function getSceneMeta(
  type: 'movie' | 'series',
  baseId: string,
  fallback: { title: string; year: string }
): Promise<SceneMeta> {
  if (baseId.startsWith('tt')) {
    const m = await getCinemetaMeta(type, baseId);
    if (m?.title) return { title: m.title, year: m.year || fallback.year };
  }
  return { title: fallback.title, year: fallback.year };
}

// "Dune: Part Two" -> "Dune.Part.Two" ; strip accents and : , ' ! ?
export function normalizeForFilename(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // accents
    .replace(/[:,'’!?]/g, '')          // punctuation to drop entirely
    .replace(/[^A-Za-z0-9]+/g, '.')    // any other run -> single dot
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
}

// Map our internal language tag to a scene-style token. VO -> none (default EN).
function mapLang(lang: string): string {
  const l = (lang || '').toUpperCase();
  if (l.includes('MULTI')) return 'MULTI';
  if (l.includes('VOSTFR')) return 'VOSTFR';
  if (l === 'VF' || l.includes('FRENCH') || l === 'VFF' || l === 'VFQ' || l === 'FR') return 'FRENCH';
  if (l === 'VO' || l.includes('ENGLISH') || l.includes('ORIGINAL') || l === 'EN') return '';
  return ''; // unknown -> no lang tag (safer for the parser than garbage)
}

// Map our quality tag to a resolution token.
function mapResolution(quality: string): string {
  const q = (quality || '').toLowerCase();
  if (q.includes('2160') || q.includes('4k')) return '2160p';
  if (q.includes('1080')) return '1080p';
  if (q.includes('720')) return '720p';
  if (q.includes('480')) return '480p';
  if (q === 'hd' || q.includes('hd')) return '720p'; // HD is ambiguous; be conservative
  return 'Unknown';
}

const PROVIDER_LABELS: Record<string, string> = {
  movix: 'Movix',
  netmirror: 'NetMirror',
  streamflix: 'StreamFlix',
  faklum: 'Faklum',
  flemmix: 'Flemmix',
  frenchstream: 'FrenchStream',
  cinemaos: 'CinemaOS',
  wiflix: 'Wiflix',
};

export function providerLabel(source: string): string {
  return PROVIDER_LABELS[source] || (source ? source.charAt(0).toUpperCase() + source.slice(1) : 'Unknown');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export interface FilenameParts {
  title: string;
  year: string;
  isSeries: boolean;
  season?: number;
  episode?: number;
  lang: string;       // our internal tag (MULTI/VF/VOSTFR/VO/...)
  resolution: string; // our internal quality tag (1080p/720p/HD/...)
  provider: string;   // display label (Movix/Flemmix/...)
}

// Films : {Title}.{Year}.{Lang}.{Resolution}.WEB-DL.x264-{Provider}.mkv
// Séries : {Title}.S{NN}E{NN}.{Year}.{Lang}.{Resolution}.WEB-DL.x264-{Provider}.mkv
export function buildFilename(p: FilenameParts): string {
  const segments: string[] = [normalizeForFilename(p.title)];

  if (p.isSeries && p.season != null && p.episode != null) {
    segments.push(`S${pad2(p.season)}E${pad2(p.episode)}`);
  }
  if (p.year) segments.push(p.year);

  const langTok = mapLang(p.lang);
  if (langTok) segments.push(langTok);

  segments.push(mapResolution(p.resolution));
  segments.push('WEB-DL');
  segments.push(`x264-${p.provider}`);

  return segments.filter(Boolean).join('.') + '.mkv';
}

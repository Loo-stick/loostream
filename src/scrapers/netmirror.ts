import axios from 'axios';
import { cached } from '../cache';

const STREAMS_TTL_MS = 15 * 60 * 1000;

const NETMIRROR_BASE = 'https://net22.cc';
const NETMIRROR_PLAY = 'https://net52.cc';

type Platform = 'netflix' | 'primevideo' | 'disney';

interface PlatformConfig {
  ott: string;
  label: string;
  searchEndpoint: string;
  episodesEndpoint: string;
  postEndpoint: string;
  playlistEndpoint: string;
}

const PLATFORMS: Record<Platform, PlatformConfig> = {
  netflix: {
    ott: 'nf',
    label: 'Netflix',
    searchEndpoint: `${NETMIRROR_BASE}/search.php`,
    episodesEndpoint: `${NETMIRROR_BASE}/episodes.php`,
    postEndpoint: `${NETMIRROR_BASE}/post.php`,
    playlistEndpoint: `${NETMIRROR_PLAY}/playlist.php`,
  },
  primevideo: {
    ott: 'pv',
    label: 'Prime Video',
    searchEndpoint: `${NETMIRROR_BASE}/pv/search.php`,
    episodesEndpoint: `${NETMIRROR_BASE}/pv/episodes.php`,
    postEndpoint: `${NETMIRROR_BASE}/pv/post.php`,
    playlistEndpoint: `${NETMIRROR_PLAY}/pv/playlist.php`,
  },
  disney: {
    ott: 'hs',
    label: 'Disney+',
    searchEndpoint: `${NETMIRROR_BASE}/mobile/hs/search.php`,
    episodesEndpoint: `${NETMIRROR_BASE}/mobile/hs/episodes.php`,
    postEndpoint: `${NETMIRROR_BASE}/mobile/hs/post.php`,
    playlistEndpoint: `${NETMIRROR_PLAY}/mobile/hs/playlist.php`,
  },
};

// Cookie cache
let cachedCookie = '';
let cookieTimestamp = 0;
const COOKIE_EXPIRY_MS = 10 * 60 * 1000;

export interface StreamResult {
  platform: Platform;
  contentId: string;
  quality: string;
  title: string;
  languages: string[];
}

async function bypass(): Promise<string | null> {
  const now = Date.now();
  if (cachedCookie && (now - cookieTimestamp) < COOKIE_EXPIRY_MS) {
    return cachedCookie;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await axios.post(`${NETMIRROR_PLAY}/tv/p.php`, null, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*',
        },
      });

      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      if (!text.includes('"r":"n"')) continue;

      const setCookie = response.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie || '');
      const match = cookieStr.match(/t_hash_t=([^;,\s]+)/);

      if (match?.[1]) {
        cachedCookie = match[1];
        cookieTimestamp = Date.now();
        console.log('[Netmirror] Auth successful');
        return cachedCookie;
      }
    } catch (e) {
      console.log(`[Netmirror] Bypass attempt ${attempt + 1} failed`);
    }
  }
  return null;
}

function buildHeaders(cookie: string, ott: string): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': `t_hash_t=${cookie}; user_token=233123f803cf02184bf6c67e149cdd50; hd=on; ott=${ott}`,
    'Referer': `${NETMIRROR_BASE}/tv/home`,
  };
}

function normalize(str: string): string {
  // Remove special chars like / and normalize for comparison
  return str.toLowerCase().trim().replace(/[\/\-_:]/g, '');
}

function similarity(a: string, b: string): number {
  const s1 = normalize(a);
  const s2 = normalize(b);
  if (s1 === s2) return 1;
  if (s1.startsWith(s2) || s2.startsWith(s1)) return 0.9;

  // Also compare with spaces normalized
  const words1 = s1.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, ''));
  const words2 = s2.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, ''));
  const shorter = words1.length < words2.length ? words1 : words2;
  const longer = words1.length < words2.length ? words2 : words1;
  const matched = shorter.filter(w => longer.includes(w)).length;
  return matched / longer.length;
}

async function searchPlatform(
  platform: Platform,
  title: string,
  year: string,
  cookie: string
): Promise<{ id: string; title: string } | null> {
  const config = PLATFORMS[platform];
  const headers = buildHeaders(cookie, config.ott);

  const doSearch = async (query: string) => {
    try {
      const url = `${config.searchEndpoint}?s=${encodeURIComponent(query)}&t=${Math.floor(Date.now() / 1000)}`;
      const { data } = await axios.get(url, { headers });

      const results = (data.searchResult || [])
        .map((item: { id: string; t: string }) => ({
          id: item.id,
          title: item.t,
          score: similarity(item.t, title),
        }))
        .filter((r: { score: number }) => r.score >= 0.7)
        .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

      return results.length > 0 ? { id: results[0].id, title: results[0].title } : null;
    } catch {
      return null;
    }
  };

  // Try original title first
  let result = await doSearch(title);
  // Try without special characters (Re/Member -> ReMember)
  if (!result) {
    const cleanTitle = title.replace(/\//g, '');
    if (cleanTitle !== title) {
      result = await doSearch(cleanTitle);
    }
  }
  // Try with year
  if (!result && year) {
    result = await doSearch(`${title} ${year}`);
  }
  if (!result && year) {
    const cleanTitle = title.replace(/\//g, '');
    if (cleanTitle !== title) {
      result = await doSearch(`${cleanTitle} ${year}`);
    }
  }
  return result;
}

async function loadContent(platform: Platform, contentId: string, cookie: string) {
  const config = PLATFORMS[platform];
  const headers = buildHeaders(cookie, config.ott);
  const url = `${config.postEndpoint}?id=${contentId}&t=${Math.floor(Date.now() / 1000)}`;

  try {
    const { data } = await axios.get(url, { headers });
    return {
      episodes: (data.episodes || []).filter(Boolean),
      seasons: data.season || [],
      langs: parseLangs(data.lang || []),
      nextPageShow: data.nextPageShow,
      nextPageSeason: data.nextPageSeason,
    };
  } catch {
    return null;
  }
}

function parseLangs(langs: Array<{ l?: string; s?: string }>): string[] {
  const langMap: Record<string, string> = {
    fra: 'French', fre: 'French', eng: 'English', deu: 'German', ger: 'German',
    spa: 'Spanish', ita: 'Italian', por: 'Portuguese', jpn: 'Japanese',
    kor: 'Korean', zho: 'Chinese', chi: 'Chinese', ara: 'Arabic', rus: 'Russian',
    hin: 'Hindi', tur: 'Turkish', pol: 'Polish', nld: 'Dutch',
  };

  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of langs) {
    const label = entry.l || langMap[(entry.s || '').toLowerCase()];
    if (label && !seen.has(label)) {
      seen.add(label);
      result.push(label);
    }
  }
  return result;
}

async function fetchEpisodes(
  platform: Platform,
  contentId: string,
  seasonId: string,
  cookie: string,
  startPage = 1
): Promise<Array<{ id: string; s?: string; ep?: string }>> {
  const config = PLATFORMS[platform];
  const headers = buildHeaders(cookie, config.ott);
  const collected: Array<{ id: string; s?: string; ep?: string }> = [];

  let page = startPage;
  while (true) {
    try {
      const url = `${config.episodesEndpoint}?s=${seasonId}&series=${contentId}&t=${Math.floor(Date.now() / 1000)}&page=${page}`;
      const { data } = await axios.get(url, { headers });

      if (data.episodes) {
        collected.push(...data.episodes.filter(Boolean));
      }
      if (data.nextPageShow === 0) break;
      page++;
    } catch {
      break;
    }
  }
  return collected;
}

function findEpisode(
  episodes: Array<{ id: string; s?: string; ep?: string; season?: number; episode?: number }>,
  targetSeason: number,
  targetEpisode: number
): { id: string } | null {
  return episodes.find(ep => {
    if (!ep) return false;
    let epS: number, epE: number;

    if (ep.s && ep.ep) {
      epS = parseInt(String(ep.s).replace(/\D/g, ''));
      epE = parseInt(String(ep.ep).replace(/\D/g, ''));
    } else if (ep.season !== undefined && ep.episode !== undefined) {
      epS = ep.season;
      epE = ep.episode;
    } else {
      return false;
    }
    return epS === targetSeason && epE === targetEpisode;
  }) || null;
}

export async function getStreams(
  title: string,
  year: string,
  season?: number,
  episode?: number
): Promise<StreamResult[]> {
  const normTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
  const key = `netmirror:${normTitle}:${year || ''}:${season || ''}:${episode || ''}`;
  return cached(
    key,
    STREAMS_TTL_MS,
    () => fetchNetmirrorStreams(title, year, season, episode),
    { scope: 'netmirror', shouldCache: r => r.length > 0 }
  );
}

async function fetchNetmirrorStreams(
  title: string,
  year: string,
  season?: number,
  episode?: number
): Promise<StreamResult[]> {
  const cookie = await bypass();
  if (!cookie) {
    console.log('[Netmirror] Auth failed');
    return [];
  }

  const results: StreamResult[] = [];
  const platforms: Platform[] = ['netflix', 'primevideo', 'disney'];

  for (const platform of platforms) {
    try {
      console.log(`[Netmirror] Searching ${PLATFORMS[platform].label} for "${title}"...`);

      const searchResult = await searchPlatform(platform, title, year, cookie);
      if (!searchResult) {
        console.log(`[Netmirror] Not found on ${PLATFORMS[platform].label}`);
        continue;
      }

      console.log(`[Netmirror] Found: ${searchResult.title} (${searchResult.id})`);

      const content = await loadContent(platform, searchResult.id, cookie);
      if (!content) continue;

      let targetId = searchResult.id;

      // For TV shows, find the episode
      if (season && episode) {
        let allEpisodes = [...content.episodes];

        // Fetch more episodes if needed
        if (content.nextPageShow === 1 && content.nextPageSeason) {
          const more = await fetchEpisodes(platform, searchResult.id, content.nextPageSeason, cookie, 2);
          allEpisodes.push(...more);
        }

        // Fetch from other seasons
        for (const s of content.seasons.slice(0, -1)) {
          const seasonEps = await fetchEpisodes(platform, searchResult.id, s.id, cookie, 1);
          allEpisodes.push(...seasonEps);
        }

        const ep = findEpisode(allEpisodes, season, episode);
        if (!ep) {
          console.log(`[Netmirror] S${season}E${episode} not found on ${PLATFORMS[platform].label}`);
          continue;
        }
        targetId = ep.id;
      }

      // Return results for different qualities
      for (const quality of ['1080p', '720p', '480p']) {
        results.push({
          platform,
          contentId: targetId,
          quality,
          title: `${PLATFORMS[platform].label} - ${searchResult.title}`,
          languages: content.langs,
        });
      }

      console.log(`[Netmirror] Added ${PLATFORMS[platform].label} streams`);
    } catch (e) {
      console.log(`[Netmirror] Error on ${PLATFORMS[platform].label}:`, e);
    }
  }

  return results;
}

// Check audio languages in HLS manifest
export async function checkAudioLanguages(
  hlsUrl: string,
  requiredLangs: string[] = ['fra', 'eng']
): Promise<{ available: string[]; hasRequired: boolean }> {
  try {
    const resp = await axios.get(hlsUrl, {
      headers: {
        'Referer': 'https://net52.cc/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 10000,
    });

    const manifest = resp.data;
    const audioLangs: string[] = [];

    // Parse EXT-X-MEDIA lines for audio tracks
    const mediaLines = manifest.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]+/g) || [];
    for (const line of mediaLines) {
      const langMatch = line.match(/LANGUAGE="([^"]+)"/);
      if (langMatch) {
        audioLangs.push(langMatch[1].toLowerCase());
      }
    }

    // Check if required languages are present
    const hasRequired = requiredLangs.every(lang =>
      audioLangs.some(available =>
        available === lang ||
        available.startsWith(lang) ||
        (lang === 'fra' && available === 'fre') ||
        (lang === 'eng' && available === 'en')
      )
    );

    return { available: audioLangs, hasRequired };
  } catch (e) {
    console.log('[Netmirror] Error checking audio languages:', e);
    return { available: [], hasRequired: false };
  }
}

// Verify HLS URL works and has video streams
async function verifyHlsUrl(url: string, platform: string): Promise<boolean> {
  try {
    const resp = await axios.get(url, {
      headers: {
        'Referer': 'https://net52.cc/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 5000,
    });

    const manifest = resp.data;

    // Must have EXT-X-STREAM-INF (video variants) or video segments (.ts)
    // Just having AUDIO tracks is not enough
    const hasVideoVariants = manifest.includes('#EXT-X-STREAM-INF');
    const hasVideoSegments = manifest.includes('.ts');

    // Check if it's audio-only (has AUDIO but no video)
    const hasAudioOnly = manifest.includes('TYPE=AUDIO') && !hasVideoVariants && !hasVideoSegments;

    if (hasAudioOnly) {
      console.log(`[Netmirror] ${platform} manifest is audio-only, rejecting`);
      return false;
    }

    if (hasVideoVariants || hasVideoSegments) {
      console.log(`[Netmirror] ${platform} manifest verified OK`);
      return true;
    }

    console.log(`[Netmirror] ${platform} manifest has no video content`);
    return false;
  } catch (e) {
    console.log(`[Netmirror] ${platform} manifest fetch failed:`, e);
    return false;
  }
}

// Get fresh HLS URL for playback
export async function getStreamUrl(
  platform: Platform,
  contentId: string,
  quality: string
): Promise<string | null> {
  const cookie = await bypass();
  if (!cookie) return null;

  const config = PLATFORMS[platform];
  const jar = `t_hash_t=${cookie}; ott=${config.ott}; hd=on`;

  try {
    // Step 1: POST play.php
    const playResp = await axios.post(`${NETMIRROR_BASE}/play.php`, `id=${contentId}`, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${NETMIRROR_BASE}/`,
        'Cookie': jar,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const h = playResp.data.h;

    // Step 2: GET play.php on PLAY domain
    const htmlResp = await axios.get(`${NETMIRROR_PLAY}/play.php?id=${contentId}&${h}`, {
      headers: {
        'Accept': 'text/html,*/*',
        'Referer': `${NETMIRROR_BASE}/`,
        'Cookie': jar,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const tokenMatch = htmlResp.data.match(/data-h="([^"]+)"/);
    if (!tokenMatch) return null;
    const token = tokenMatch[1];

    // Step 3: Get playlist
    const playlistUrl = `${config.playlistEndpoint}?id=${contentId}&t=stream&tm=${Math.floor(Date.now() / 1000)}&h=${encodeURIComponent(token)}`;
    const playlistResp = await axios.get(playlistUrl, {
      headers: {
        'Cookie': jar,
        'Referer': `${NETMIRROR_PLAY}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    });

    const playlist = playlistResp.data;
    if (!Array.isArray(playlist) || playlist.length === 0) return null;

    console.log(`[Netmirror] Playlist response for ${platform}:`, JSON.stringify(playlist).substring(0, 500));

    // Find matching quality
    for (const item of playlist) {
      for (const src of (item.sources || [])) {
        const srcUrl = src.file || '';
        const srcQuality = (src.label || '').toLowerCase();

        if (quality === '1080p' && !srcQuality.includes('full')) continue;
        if (quality === '720p' && !srcQuality.includes('mid')) continue;
        if (quality === '480p' && !srcQuality.includes('low')) continue;

        if (srcUrl) {
          let finalUrl = srcUrl.replace(/^\/tv\//, '/');
          if (!finalUrl.startsWith('http')) {
            finalUrl = `${NETMIRROR_PLAY}${finalUrl.startsWith('/') ? '' : '/'}${finalUrl}`;
          }
          console.log(`[Netmirror] Generated URL for ${platform}/${quality}: ${finalUrl}`);

          // Verify the URL works
          const isValid = await verifyHlsUrl(finalUrl, platform);
          if (!isValid) {
            console.log(`[Netmirror] URL verification failed for ${platform}/${quality}`);
            return null;
          }
          return finalUrl;
        }
      }
    }

    // Fallback to first available
    const first = playlist[0]?.sources?.[0];
    if (first?.file) {
      let finalUrl = first.file.replace(/^\/tv\//, '/');
      if (!finalUrl.startsWith('http')) {
        finalUrl = `${NETMIRROR_PLAY}${finalUrl.startsWith('/') ? '' : '/'}${finalUrl}`;
      }
      console.log(`[Netmirror] Fallback URL for ${platform}: ${finalUrl}`);

      // Verify the URL works
      const isValid = await verifyHlsUrl(finalUrl, platform);
      if (!isValid) {
        console.log(`[Netmirror] Fallback URL verification failed for ${platform}`);
        return null;
      }
      return finalUrl;
    }

    console.log(`[Netmirror] No URL found for ${platform}`);
    return null;
  } catch (e) {
    console.log('[Netmirror] Error getting stream URL:', e);
    return null;
  }
}

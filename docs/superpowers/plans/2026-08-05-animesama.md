# Source AnimeSama — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Ajouter AnimeSama (anime VOSTFR/VF) : extracteur `ansembed` + scraper `animesama.ts` + câblage gaté `ja`.

**Architecture:** Scraper HTML (comme voiranime/coflix) : search fetch.php → slug via matcher → episodes.js → extraction sibnet/ansembed. Base rotative `anime-sama.to`.

## Global Constraints
- Commits FR conventionnels, `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Réutiliser `matching.pickBest/accepts` (titre strict), `applyMultiAudio` (qualité), `detectExtractor`/`extractStream`, `makeEndpointConfig`.
- Gaté anime (`originalLanguage === 'ja'`) comme VoirAnime.

---

### Task 1 : Extracteur `ansembed`

**Files:** Modify `src/extractors/index.ts` ; test `src/extractors/index.test.ts` (si un parseur pur est extractible) sinon vérif live.

- [ ] **Step 1 :** `ExtractorId` += `'ansembed'` ; l'ajouter à la liste des extracteurs locaux ; host map `ansembed: ['ansembed.net']`.
- [ ] **Step 2 :** `case 'ansembed':` dans le switch → `extractAnsembed(embedUrl)` :
  ```ts
  // ansembed.net : jwplayer avec l'URL HLS en clair dans `sources:[{file:"...m3u8"}]`.
  async function extractAnsembed(embedUrl: string): Promise<ExtractedStream | null> {
    try {
      const { data } = await axios.get<string>(embedUrl, {
        headers: { ...HEADERS, Referer: 'https://anime-sama.to/' },
        timeout: 15000, responseType: 'text', transformResponse: r => r,
      });
      const url = findStreamUrl(String(data)); // regex file:/source:/sources -> .m3u8 (déjà)
      if (!url || !/\.m3u8/i.test(url)) return null;
      return { url, quality: 'HD', format: 'hls', headers: { Referer: 'https://ansembed.net/' } };
    } catch { return null; }
  }
  ```
  (`findStreamUrl` est déjà importé/utilisé dans ce fichier.)
- [ ] **Step 3 : build** — `npm run build` → OK.
- [ ] **Step 4 : vérif live** — extraire l'URL ansembed d'un épisode réel → doit sortir un `.m3u8` (vmpx.online). Commit `feat(extractor): ansembed (jwplayer HLS en clair)`.

---

### Task 2 : Module `src/scrapers/animesama.ts` + config

**Files:** Create `src/scrapers/animesama.ts`, `config/animesama-endpoints.json`, `src/scrapers/animesama.test.ts`

**Interfaces produites :**
- `getAnimeSamaStreams(mediaType, titles: string[], season?, episode?, extractorConfig): Promise<AnimeSamaStream[]>`
- `reloadAnimesamaEndpoints`, `getAnimesamaEndpoints`
- `parseEpisodesJs(js: string, episodeIndex: number): string[]` (pur, testable — renvoie les URLs de l'épisode, une par lecteur)

- [ ] **Step 1 : test du parseur** (`animesama.test.ts`)
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { parseEpisodesJs } from './animesama';

test('parseEpisodesJs : une URL par tableau-lecteur pour l’épisode demandé', () => {
  const js = `var eps1 = [\n'https://a.net/e/1a',\n'https://a.net/e/2a',\n];\nvar eps2 = [\n'https://sibnet.ru/1b',\n'https://sibnet.ru/2b',\n];`;
  assert.deepEqual(parseEpisodesJs(js, 1), ['https://a.net/e/2a', 'https://sibnet.ru/2b']); // épisode 2 -> index 1
  assert.deepEqual(parseEpisodesJs(js, 0), ['https://a.net/e/1a', 'https://sibnet.ru/1b']);
});
```

- [ ] **Step 2 : implémenter** (`animesama.ts`) — squelette :
```ts
import axios from 'axios';
import { cached } from '../cache';
import { makeEndpointConfig } from '../endpoint-config';
import { ExtractorConfig, detectExtractor, extractStream } from '../extractors';
import { applyMultiAudio } from '../multiaudio';
import { Wanted, pickBest } from '../matching';

const STREAMS_TTL_MS = 15 * 60 * 1000;
const endpoints = makeEndpointConfig('animesama-endpoints.json', 'ANIMESAMA_ENDPOINTS_CONFIG', { base: 'https://anime-sama.to' });
export const reloadAnimesamaEndpoints = endpoints.reload;
export const getAnimesamaEndpoints = endpoints.get;
const BASE = () => endpoints.get().base.replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface AnimeSamaStream { name: string; url: string; quality: string; language: string; headers?: Record<string, string>; }

/** Renvoie une URL par tableau-lecteur (var epsN) pour l'épisode `idx` (0-based). */
export function parseEpisodesJs(js: string, idx: number): string[] {
  const out: string[] = [];
  for (const m of js.matchAll(/var\s+eps\w+\s*=\s*\[([\s\S]*?)\]/g)) {
    const urls = [...m[1].matchAll(/['"]((?:https?:)?\/\/[^'"]+)['"]/g)].map(u => u[1]);
    if (urls[idx]) out.push(urls[idx].startsWith('//') ? 'https:' + urls[idx] : urls[idx]);
  }
  return out;
}

async function getText(url: string, referer: string): Promise<string | null> {
  try {
    const { data, status } = await axios.get<string>(url, { headers: { 'User-Agent': UA, Referer: referer }, timeout: 12000, responseType: 'text', transformResponse: r => r, validateStatus: () => true });
    return status >= 200 && status < 300 ? String(data) : null;
  } catch { return null; }
}

// 1) Recherche -> slug via matcher.
async function findSlug(titles: string[]): Promise<string | null> {
  const base = BASE();
  for (const t of titles) {
    try {
      const { data } = await axios.post<string>(`${base}/template-php/defaut/fetch.php`, `query=${encodeURIComponent(t)}`,
        { headers: { 'User-Agent': UA, Referer: `${base}/`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000, responseType: 'text', transformResponse: r => r });
      const items: { title: string; year?: number; item: string }[] = [];
      for (const m of String(data).matchAll(/href="[^"]*\/catalogue\/([a-z0-9-]+)\/"[\s\S]*?asn-search-result-title">([^<]+)</gi)) {
        items.push({ title: m[2].trim(), item: m[1] });
      }
      const best = pickBest({ titles } as Wanted, items);
      if (best) return best.item;
    } catch { /* essayer le titre suivant */ }
  }
  return null;
}

async function fetchAnimeSamaStreams(mediaType: 'movie' | 'series', titles: string[], season: number | undefined, episode: number | undefined, extractorConfig: ExtractorConfig): Promise<AnimeSamaStream[]> {
  const base = BASE();
  const slug = await findSlug(titles);
  if (!slug) { console.log(`[AnimeSama] Aucun match pour "${titles[0]}"`); return []; }
  const seasonPath = mediaType === 'movie' ? 'film' : `saison${season}`;
  const idx = mediaType === 'movie' ? 0 : (episode! - 1);
  const streams: AnimeSamaStream[] = [];
  for (const lang of ['vostfr', 'vf']) {
    const js = await getText(`${base}/catalogue/${slug}/${seasonPath}/${lang}/episodes.js`, `${base}/catalogue/${slug}/`);
    if (!js) continue;
    const urls = parseEpisodesJs(js, idx);
    // Prioriser les hôtes qu'on sait extraire (sibnet, ansembed), 1er succès par langue.
    const supported = urls.filter(u => detectExtractor(u));
    for (const u of supported) {
      const ex = await extractStream(u, extractorConfig).catch(() => null);
      if (ex?.url) {
        streams.push({ name: 'AnimeSama', url: ex.url, quality: ex.quality || 'HD', language: lang === 'vf' ? 'VF' : 'VOSTFR', headers: ex.headers });
        break; // une source suffit par langue
      }
    }
  }
  console.log(`[AnimeSama] "${titles[0]}" ${seasonPath} -> ${streams.length} stream(s)`);
  return streams;
}

export async function getAnimeSamaStreams(mediaType: 'movie' | 'series', titles: string[], season: number | undefined, episode: number | undefined, extractorConfig: ExtractorConfig): Promise<AnimeSamaStream[]> {
  if (!titles.length) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const mode = extractorConfig.useMediaFlow ? 'mf' : 'loc';
  const key = `animesama:${mode}:${mediaType}:${titles[0].toLowerCase()}:${season || ''}:${episode || ''}`;
  return cached(key, STREAMS_TTL_MS, async () => { const s = await fetchAnimeSamaStreams(mediaType, titles, season, episode, extractorConfig); return applyMultiAudio(s); }, { scope: 'animesama', shouldCache: r => r.length > 0 });
}
```
⚠️ Vérifier la signature réelle de `extractStream(url, config)` et le type `ExtractedStream` (`url`/`quality`/`headers`) et **adapter** (au besoin `extractStream(u, extractorConfig)` renvoie déjà l'URL finale proxifiable — sinon utiliser la même voie que voiranime/coflix `extractAll`).

- [ ] **Step 3 : config** — `config/animesama-endpoints.json` : `{ "_comment": "Base AnimeSama (rotatif : anime-sama.to/.pw)", "base": "https://anime-sama.to" }`.
- [ ] **Step 4 : test parseur** — `node --import tsx --test src/scrapers/animesama.test.ts` → PASS.
- [ ] **Step 5 : build + commit** — `feat(animesama): scraper anime (search+matcher, episodes.js, VOSTFR/VF)`.

---

### Task 3 : Câblage `src/index.ts`

**Files:** Modify `src/index.ts`

- [ ] **Step 1 :** import `getAnimeSamaStreams, reloadAnimesamaEndpoints, getAnimesamaEndpoints`.
- [ ] **Step 2 :** fan-out — ajouter une 12ᵉ source **gatée `ja`** (mirroir de VoirAnime l.843) :
  ```ts
  (info.originalLanguage === 'ja'
    ? getAnimeSamaStreams(type as 'movie' | 'series', [info.title, info.originalTitle, info.frenchTitle].filter(Boolean) as string[], parsed.season, parsed.episode, extractorConfig)
    : Promise.resolve([]))
    .then(r => { if (info.originalLanguage === 'ja') { trackSourceResult('animesama', true, r.length); recordOutcome('animesama', r.length > 0 ? 'success' : 'empty'); } return r; })
    .catch(e => { console.log('[AnimeSama] Error:', e); trackSourceResult('animesama', false); recordOutcome('animesama', 'error', e?.message); return []; }),
  ```
- [ ] **Step 3 :** `SOURCE_NAMES += 'animesama'` (12ᵉ), `const animesamaResults = collected[11] as ...`.
- [ ] **Step 4 :** bloc de livraison (mirroir voiranime/coflix) : pour chaque `AnimeSamaStream`, `deliver(url, headers, { forceHls: /\.m3u8/i.test(url) }, req, config)` → draft `_meta { quality, language, source:'animesama' }`.
- [ ] **Step 5 :** types stats/metrics += `animesama` (interfaces `stats.sources`, `streamsServed`, `trackSourceResult` union, `src/metrics.ts` `Scraper` + `buffers` + `getAllMetrics`).
- [ ] **Step 6 :** endpoint admin — ajouter `{ path: 'animesama', file: 'animesama-endpoints.json', reload: reloadAnimesamaEndpoints }` à `singleBaseSources` + `GET /api/animesama/endpoints`.
- [ ] **Step 7 : build + commit** — `feat(animesama): câblage fan-out (gaté ja), delivery, metrics, endpoint admin`.

---

### Task 4 : Vérif réelle + déploiement
- [ ] **Step 1 :** `npm test` (parseur + non-régression) vert.
- [ ] **Step 2 :** `npm run build && docker compose up -d --build loostream`.
- [ ] **Step 3 : vérif en conteneur** — Jujutsu Kaisen (tmdb série) S2E1 : `getAnimeSamaStreams('series',['Jujutsu Kaisen'],2,1,cfg)` → ≥1 stream VOSTFR jouable (URL m3u8/mp4).
- [ ] **Step 4 :** validation Stremio (un anime, VOSTFR + VF si dispo).

## Self-Review (fait)
- Couverture spec : extracteur ansembed (T1), scraper+config+parseur (T2), câblage complet (T3), vérif (T4). ✓
- Placeholders : aucun ; code réel. Point ⚠️ explicite : valider la signature `extractStream`/`ExtractedStream` et calquer la voie d'extraction de voiranime si besoin. ✓
- Types : `getAnimeSamaStreams`/`parseEpisodesJs`/`AnimeSamaStream` cohérents ; `animesama` ajouté partout (metrics/stats). ✓

# CinemaOS Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cinemaos.live as a LooStream source — a TMDB-keyed meta-aggregator (~8 curated scrapers) delivering VO/recent HLS streams **with subtitles**, filling gaps the other scrapers miss.

**Architecture:** A new `src/scrapers/cinemaos.ts` reproduces cinemaos's client protocol server-side: sign the request (double HMAC-SHA256, keys in `config/cinemaos.json`), call `/api/providerv4/scrape` per scraper in parallel, AES-256-GCM-decrypt each response, extract HLS sources + `.srt` captions. Results flow through the existing `buildProxyUrl` proxy and stream-assembly in `handleStream`, exactly like the StreamFlix source.

**Tech Stack:** TypeScript (Node 22), `axios`, Node `crypto`, existing `cached()` cache, hand-rolled Express. No unit-test framework exists — verification is `npm run build` (tsc strict) + a standalone `ts-node` probe script + `curl` end-to-end against the running container.

## Global Constraints

- TypeScript strict — code MUST pass `npm run build` (`tsc`) with zero errors.
- Rebuild flow: `npm run build` locally BEFORE `docker compose up -d --build loostream` (Dockerfile copies prebuilt `dist/`).
- `config/` is bind-mounted and hot-reloaded via `fs.watch`; secrets/keys live there, never hardcoded in `dist`.
- Follow the existing scraper pattern (see `src/scrapers/streamflix.ts` / `netmirror.ts`): a single `getXStreams(...)` export returning a typed array, `cached()` with `scope`, one-line `console.log` diagnostics.
- Cracked constants (verbatim):
  - PRIMARY  = `a7f3b9c2e8d4f1a6b5c9e2d7f4a8b3c6e1d9f7a4b2c8e5d3f9a6b4c1e7d2f8a5`
  - SECONDARY = `d3f8a5b2c9e6d1f7a4b8c5e2d9f3a6b1c7e4d8f2a9b5c3e7d4f1a8b6c2e9d5f3`
  - ENC_KEY  = `a1b2c3d4e4f6477658455678901477567890abcdef1234567890abcdef123456`
  - GT       = `2549b22d9bf0d91847a2811baac98d0079e02dba592aea94`
  - Known-good secret for Endgame (`tmdbId:299534|imdbId:tt4154796`) = `ba7f3b4e283ecfcfd04b23d5aee1c54ff7b5b470d2be3a93dd611800f862fba4`

---

### Task 1: Config file + crypto core (`sign`, `decrypt`, config loader)

**Files:**
- Create: `config/cinemaos.json`
- Create: `src/scrapers/cinemaos.ts`
- Test: `scripts/cinemaos-probe.ts` (throwaway verification script, committed)

**Interfaces:**
- Produces:
  - `signSecret(m: {tmdbId?: string; imdbId?: string; season?: string; episode?: string}): string`
  - `decryptData(o: {encrypted: string; cin: string; mao: string; salt?: string; version?: number; useKeyDerivation?: boolean}): any`
  - `loadCinemaosConfig(): CinemaosConfig` where `CinemaosConfig = {base: string; primaryKey: string; secondaryKey: string; encKey: string; gt: string; scrapers: string[]}`

- [ ] **Step 1: Create the config file**

`config/cinemaos.json`:
```json
{
  "_comment": "Clés/protocole CinemaOS. Modifiable sans rebuild (hot-reload). Si cinemaos tourne ses clés: recharger via /api/cinemaos/config?reload=true. Ré-extraction: charger cinemaos.live/movie/watch/<tmdbId>, lire module webpack 18310 (generateContentHash) pour primaryKey/secondaryKey, module 91712 (decryptData) pour encKey, grep du bundle pour gt.",
  "base": "https://cinemaos.live",
  "primaryKey": "a7f3b9c2e8d4f1a6b5c9e2d7f4a8b3c6e1d9f7a4b2c8e5d3f9a6b4c1e7d2f8a5",
  "secondaryKey": "d3f8a5b2c9e6d1f7a4b8c5e2d9f3a6b1c7e4d8f2a9b5c3e7d4f1a8b6c2e9d5f3",
  "encKey": "a1b2c3d4e4f6477658455678901477567890abcdef1234567890abcdef123456",
  "gt": "2549b22d9bf0d91847a2811baac98d0079e02dba592aea94",
  "scrapers": ["n3", "z2", "s7", "l5", "f8", "h0", "b5", "q4"]
}
```

- [ ] **Step 2: Write `cinemaos.ts` config loader + crypto (minimal, no network yet)**

`src/scrapers/cinemaos.ts`:
```typescript
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { cached } from '../cache';

export interface CinemaosConfig {
  base: string;
  primaryKey: string;
  secondaryKey: string;
  encKey: string;
  gt: string;
  scrapers: string[];
}

const CONFIG_PATH = process.env.CINEMAOS_CONFIG || path.join(process.cwd(), 'config', 'cinemaos.json');

let cfg: CinemaosConfig = loadFromDisk();

function loadFromDisk(): CinemaosConfig {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return {
    base: raw.base || 'https://cinemaos.live',
    primaryKey: raw.primaryKey,
    secondaryKey: raw.secondaryKey,
    encKey: raw.encKey,
    gt: raw.gt,
    scrapers: Array.isArray(raw.scrapers) ? raw.scrapers : [],
  };
}

export function loadCinemaosConfig(): CinemaosConfig {
  return cfg;
}

export function reloadCinemaosConfig(): CinemaosConfig {
  cfg = loadFromDisk();
  console.log(`[CinemaOS] Config reloaded (${cfg.scrapers.length} scrapers)`);
  return cfg;
}

try {
  fs.watch(path.dirname(CONFIG_PATH), (_e, f) => {
    if (f === 'cinemaos.json') { try { reloadCinemaosConfig(); } catch (e: any) { console.log(`[CinemaOS] reload failed: ${e.message}`); } }
  });
} catch { /* watch is best-effort */ }

// secret = HMAC_SHA256(secondary, HMAC_SHA256(primary, "tmdbId:..|imdbId:..|seasonId:..|episodeId:.."))
export function signSecret(m: { tmdbId?: string; imdbId?: string; season?: string; episode?: string }): string {
  const parts: string[] = [];
  if (m.tmdbId) parts.push(`tmdbId:${m.tmdbId}`);
  if (m.imdbId) parts.push(`imdbId:${m.imdbId}`);
  if (m.season) parts.push(`seasonId:${m.season}`);
  if (m.episode) parts.push(`episodeId:${m.episode}`);
  const canon = parts.join('|');
  const r = crypto.createHmac('sha256', cfg.primaryKey).update(canon).digest('hex');
  return crypto.createHmac('sha256', cfg.secondaryKey).update(r).digest('hex');
}

// AES-256-GCM decrypt of the providerv4 `data` object.
export function decryptData(o: { encrypted: string; cin: string; mao: string; salt?: string; version?: number; useKeyDerivation?: boolean }): any {
  const d = Buffer.from(o.encrypted, 'hex');
  const iv = Buffer.from(o.cin, 'hex');
  const tag = Buffer.from(o.mao, 'hex');
  const salt = o.salt ? Buffer.from(o.salt, 'hex') : crypto.createHash('sha256').update(iv).digest().slice(0, 32);
  const useKD = !(o.useKeyDerivation === false || (o.version !== undefined && !(o.version >= 1)));
  const key = useKD ? crypto.pbkdf2Sync(cfg.encKey, salt, 100000, 32, 'sha256') : Buffer.from(cfg.encKey, 'hex');
  const dc = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dc.setAuthTag(tag);
  return JSON.parse(Buffer.concat([dc.update(d), dc.final()]).toString('utf8'));
}
```

- [ ] **Step 3: Write the probe script asserting the known-good secret**

`scripts/cinemaos-probe.ts`:
```typescript
import { signSecret } from '../src/scrapers/cinemaos';

const got = signSecret({ tmdbId: '299534', imdbId: 'tt4154796' });
const want = 'ba7f3b4e283ecfcfd04b23d5aee1c54ff7b5b470d2be3a93dd611800f862fba4';
console.log('secret:', got);
if (got !== want) { console.error('MISMATCH — expected', want); process.exit(1); }
console.log('OK: signSecret reproduces the browser secret');
```

- [ ] **Step 4: Verify build + probe**

Run: `npm run build`
Expected: tsc succeeds, zero errors.
Run: `npx ts-node scripts/cinemaos-probe.ts`
Expected: prints the secret and `OK: signSecret reproduces the browser secret`.

- [ ] **Step 5: Commit**

```bash
git add config/cinemaos.json src/scrapers/cinemaos.ts scripts/cinemaos-probe.ts
git commit -m "feat(cinemaos): config + crypto core (sign/decrypt)"
```

---

### Task 2: `getCinemaosStreams` — scrape, unwrap, extract sources + subtitles

**Files:**
- Modify: `src/scrapers/cinemaos.ts`
- Test: `scripts/cinemaos-probe.ts` (extend)

**Interfaces:**
- Consumes: `signSecret`, `decryptData`, `loadCinemaosConfig` (Task 1).
- Produces:
  ```typescript
  export interface CinemaosSubtitle { url: string; lang: string; }
  export interface CinemaosStream {
    quality: string;   // '4K' | '1080p' | '720p' | 'HD'
    url: string;       // direct HLS m3u8 (worker-unwrapped when applicable)
    referer: string;   // header the CDN needs (may be '')
    language: string;  // 'English' | 'Original' | 'Hindi' | ... | 'VO'
    server: string;    // e.g. 'Vidzee/Vega'
    subtitles: CinemaosSubtitle[];
  }
  export function getCinemaosStreams(
    tmdbId: string, imdbId: string, mediaType: 'movie' | 'series',
    title: string, year: string, season?: number, episode?: number
  ): Promise<CinemaosStream[]>
  ```

- [ ] **Step 1: Add axios import + helpers (append to `cinemaos.ts`)**

```typescript
import axios from 'axios';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;

export interface CinemaosSubtitle { url: string; lang: string; }
export interface CinemaosStream {
  quality: string; url: string; referer: string; language: string; server: string; subtitles: CinemaosSubtitle[];
}

function mapQuality(bitrate?: string): string {
  const b = String(bitrate || '').toLowerCase();
  if (b.includes('4k') || b.includes('2160')) return '4K';
  if (b.includes('fhd') || b.includes('1080')) return '1080p';
  if (b.includes('hd') && !b.includes('fhd')) return '720p';
  return 'HD';
}

// play.cinemaos.workers.dev/api/proxy?url=<enc>&referer=<enc> -> {url, referer}
function unwrapWorker(u: string): { url: string; referer: string } {
  try {
    const parsed = new URL(u);
    if (parsed.hostname.endsWith('cinemaos.workers.dev') && parsed.searchParams.get('url')) {
      return { url: parsed.searchParams.get('url')!, referer: parsed.searchParams.get('referer') || '' };
    }
  } catch { /* fall through */ }
  return { url: u, referer: '' };
}

// ISO-639 best effort from a caption's language / languageName.
function toLang(language?: string, languageName?: string): string {
  const s = `${language || ''} ${languageName || ''}`.toLowerCase();
  if (/fran|french|français/.test(s)) return 'fre';
  if (/english|anglais/.test(s)) return 'eng';
  if (/arab/.test(s)) return 'ara';
  if (/span|espa/.test(s)) return 'spa';
  if (/germ|deutsch/.test(s)) return 'ger';
  if (/ital/.test(s)) return 'ita';
  if (/port/.test(s)) return 'por';
  if (/hind/.test(s)) return 'hin';
  return (language || languageName || 'und').slice(0, 3).toLowerCase();
}
```

- [ ] **Step 2: Add the per-scraper call + fan-out + `getCinemaosStreams`**

```typescript
interface DecodedSource { url?: string; type?: string; language?: string; bitrate?: string; headers?: Record<string, string>; server?: string; }
interface DecodedResp { name?: string; sources?: Record<string, DecodedSource>; captions?: Array<{ language?: string; languageName?: string; url?: string }>; }

async function scrapeOne(
  meta: Record<string, string>, scraperId: string
): Promise<{ streams: CinemaosStream[] } | null> {
  const c = loadCinemaosConfig();
  const params = new URLSearchParams({ ...meta, secret: signSecret({ tmdbId: meta.tmdbId, imdbId: meta.imdbId, season: meta.season, episode: meta.episode }), _gt: c.gt, scraper: scraperId });
  try {
    const { data } = await axios.get(`${c.base}/api/providerv4/scrape?${params.toString()}`, {
      headers: { 'User-Agent': UA, 'x-c4os-auth': c.gt, 'Referer': `${c.base}/movie/watch/${meta.tmdbId}` },
      timeout: REQ_TIMEOUT_MS,
    });
    if (!data || !data.data || !data.data.encrypted) return null;
    const dec: DecodedResp = decryptData(data.data);
    const sources = dec.sources || {};
    const subs: CinemaosSubtitle[] = [];
    const seenLang = new Set<string>();
    for (const cap of dec.captions || []) {
      if (!cap.url) continue;
      const lang = toLang(cap.language, cap.languageName);
      if (seenLang.has(lang)) continue;
      seenLang.add(lang);
      subs.push({ url: cap.url, lang });
    }
    const streams: CinemaosStream[] = [];
    for (const [serverName, s] of Object.entries(sources)) {
      if (!s || !s.url || String(s.type || 'hls') !== 'hls') continue;
      const { url, referer } = unwrapWorker(s.url);
      streams.push({
        quality: mapQuality(s.bitrate),
        url,
        referer: referer || s.headers?.Referer || s.headers?.referer || '',
        language: s.language || 'VO',
        server: `${dec.name || scraperId}/${serverName}`,
        subtitles: subs,
      });
    }
    return { streams };
  } catch (e: any) {
    console.log(`[CinemaOS] scraper ${scraperId} failed: ${(e.message || '').slice(0, 100)}`);
    return null;
  }
}

export async function getCinemaosStreams(
  tmdbId: string, imdbId: string, mediaType: 'movie' | 'series',
  title: string, year: string, season?: number, episode?: number
): Promise<CinemaosStream[]> {
  if (!tmdbId || !imdbId) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const key = mediaType === 'series'
    ? `cinemaos:series:${tmdbId}:${season}:${episode}`
    : `cinemaos:movie:${tmdbId}`;
  return cached(key, STREAMS_TTL_MS, () => fetchCinemaos(tmdbId, imdbId, mediaType, title, year, season, episode),
    { scope: 'cinemaos', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS });
}

async function fetchCinemaos(
  tmdbId: string, imdbId: string, mediaType: 'movie' | 'series',
  title: string, year: string, season?: number, episode?: number
): Promise<CinemaosStream[]> {
  const c = loadCinemaosConfig();
  const meta: Record<string, string> = { type: mediaType === 'series' ? 'tv' : 'movie', tmdbId, imdbId, t: title, ry: year };
  if (mediaType === 'series') { meta.season = String(season); meta.episode = String(episode); }
  const results = await Promise.all(c.scrapers.map(id => scrapeOne(meta, id)));
  const streams = results.filter((r): r is { streams: CinemaosStream[] } => !!r).flatMap(r => r.streams);
  // Dedupe by url.
  const seen = new Set<string>();
  const deduped = streams.filter(s => (seen.has(s.url) ? false : (seen.add(s.url), true)));
  if (deduped.length === 0) { console.log(`[CinemaOS] No streams for "${title}" (${year})`); return []; }
  console.log(`[CinemaOS] "${title}" -> ${deduped.length} stream(s): ${deduped.map(s => `${s.server}[${s.quality}/${s.language}]`).slice(0, 8).join(', ')}`);
  return deduped;
}
```

- [ ] **Step 3: Extend the probe to hit the live API end-to-end**

Append to `scripts/cinemaos-probe.ts`:
```typescript
import { getCinemaosStreams } from '../src/scrapers/cinemaos';
(async () => {
  const r = await getCinemaosStreams('299534', 'tt4154796', 'movie', 'Avengers: Endgame', '2019');
  console.log('Endgame streams:', r.length);
  console.log('first:', JSON.stringify(r[0], null, 2).slice(0, 400));
  const sheep = await getCinemaosStreams('1301421', 'tt32565993', 'movie', 'The Sheep Detectives', '2026');
  console.log('Sheep Detectives streams:', sheep.length, '| subs on first:', sheep[0]?.subtitles?.length ?? 0);
  if (r.length === 0 || sheep.length === 0) process.exit(1);
})();
```

- [ ] **Step 4: Build + run probe**

Run: `npm run build`
Expected: zero tsc errors.
Run: `CACHE_DB_PATH=/tmp/cinemaos-test.db npx ts-node scripts/cinemaos-probe.ts`
Expected: `Endgame streams: N` (N ≥ 3), a first stream with `url` (m3u8), `Sheep Detectives streams: M` (M ≥ 1) with subtitles count ≥ 0. Exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/scrapers/cinemaos.ts scripts/cinemaos-probe.ts
git commit -m "feat(cinemaos): getCinemaosStreams — scrape, decrypt, sources + subtitles"
```

---

### Task 3: Extend `getTmdbInfo` to return `imdbId`

**Files:**
- Modify: `src/index.ts` (`getTmdbInfo`, ~line 460-492; and the `TmdbInfo` shape at the call site ~line 529)

**Interfaces:**
- Produces: `getTmdbInfo(...)` now resolves `{ title: string; year: string; tmdbId: string; imdbId: string }`.

- [ ] **Step 1: Update `getTmdbInfo` return type + body**

In `src/index.ts`, change the signature return type to include `imdbId: string`, and inside the `cached` callback compute imdbId:
- If the incoming `id` starts with `tt`, `imdbId = id`.
- Else fetch `https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${tmdbKey}` and read `.imdb_id`.

Replace the `return { title, year, tmdbId };` block with:
```typescript
        let imdbId = id.startsWith('tt') ? id : '';
        if (!imdbId) {
          try {
            const ext = await axios.get(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${tmdbKey}`);
            imdbId = ext.data?.imdb_id || '';
          } catch { /* imdbId optional */ }
        }
        return { title, year, tmdbId, imdbId };
```
Also update the function's declared return type: `Promise<{ title: string; year: string; tmdbId: string; imdbId: string } | null>`.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: zero tsc errors (any consumer of `info` still compiles; new field is additive).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(tmdb): resolve imdbId in getTmdbInfo (needed by CinemaOS)"
```

---

### Task 4: Metrics — register `cinemaos`

**Files:**
- Modify: `src/metrics.ts` (`Scraper` type ~line 6; `buffers` ~line 15-22; `getAllMetrics` ~line 108-117)

**Interfaces:**
- Produces: `Scraper` union includes `'cinemaos'`; `getAllMetrics()` returns a `cinemaos` entry.

- [ ] **Step 1: Add `cinemaos` in the three places**

- In the `Scraper` type: `... | 'frenchstream' | 'cinemaos';`
- In `buffers`: add `cinemaos: [],`
- In `getAllMetrics` return object: add `cinemaos: getMetrics('cinemaos'),`

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: zero tsc errors. (If `Record<Scraper, ...>` is used anywhere, tsc will force the new key — add it there too if flagged.)

- [ ] **Step 3: Commit**

```bash
git add src/metrics.ts
git commit -m "feat(metrics): register cinemaos scraper"
```

---

### Task 5: Wire CinemaOS into `handleStream` + config-reload endpoint

**Files:**
- Modify: `src/index.ts` (imports; stats init ~line 35-62; `trackSourceResult` union ~line 65; fan-out `Promise.all` ~line 549-566; result-processing loops ~line 615-760; filename loop ~line 776-790; `StreamWithMeta` type for `subtitles`; a new admin route near the other `/api/*` routes)

**Interfaces:**
- Consumes: `getCinemaosStreams`, `reloadCinemaosConfig` (Tasks 1-2); `info.imdbId` (Task 3); `'cinemaos'` metrics (Task 4).

- [ ] **Step 1: Imports**

Add near the other scraper imports:
```typescript
import { getCinemaosStreams, reloadCinemaosConfig } from './scrapers/cinemaos';
```

- [ ] **Step 2: Stats + tracking union**

- In the stats object init, add to the per-source block: `cinemaos: { requests: 0, success: 0, errors: 0, lastSuccess: null },`
- Add `cinemaos: number` to the `streamsServed` shape and `cinemaos: 0` to its init.
- Add `'cinemaos'` to the `trackSourceResult` source-union type parameter.

- [ ] **Step 3: Add to the parallel fan-out**

In `handleStream`'s `Promise.all([...])`, add an entry mirroring the others:
```typescript
      getCinemaosStreams(info.tmdbId, info.imdbId, type as 'movie' | 'series', info.title, info.year, parsed.season, parsed.episode)
        .then(r => { trackSourceResult('cinemaos', true, r.length); recordOutcome('cinemaos', r.length > 0 ? 'success' : 'empty'); return r; })
        .catch(e => { console.log('[CinemaOS] Error:', e); trackSourceResult('cinemaos', false); recordOutcome('cinemaos', 'error', e?.message); return []; }),
```
and destructure the new result array in the `const [...] = await Promise.all(...)` assignment (append `cinemaosResults`).

- [ ] **Step 4: Allow `subtitles` on the stream type**

In the `StreamWithMeta` interface (the stream object shape), add:
```typescript
  subtitles?: { id: string; url: string; lang: string }[];
```

- [ ] **Step 5: Process CinemaOS results into `streams[]`**

After the StreamFlix processing loop, add:
```typescript
    // Process CinemaOS results (aggregated HLS + subtitles).
    for (const cs of cinemaosResults) {
      const proxiedUrl = buildProxyUrl(cs.url, {
        ...(cs.referer ? { 'Referer': cs.referer } : {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }, false, req, config);
      if (!proxiedUrl) continue;
      streams.push({
        name: `CinemaOS ${cs.server}`,
        title: `${cs.language} [${cs.quality}]`,
        url: proxiedUrl,
        behaviorHints: { notWebReady: false, bingeGroup: `cinemaos-${cs.server}` },
        subtitles: cs.subtitles.map((s, i) => ({ id: `cinemaos-${i}-${s.lang}`, url: s.url, lang: s.lang })),
        _meta: { quality: cs.quality, language: cs.language, source: 'cinemaos' },
      });
    }
```

- [ ] **Step 6: Include CinemaOS in the filename-injection loop**

The existing loop that calls `getSceneMeta`/`buildFilename` runs over all `streams` and sets `behaviorHints.filename`. Confirm CinemaOS streams (which have `_meta.source === 'cinemaos'`) are included; if the loop filters by source, add `'cinemaos'` to the allowed set with `providerLabel` `CinemaOS`.

- [ ] **Step 7: Add the config-reload admin route**

Near the other `/api/*` routes (e.g. next to the movix endpoints reload):
```typescript
app.get('/api/cinemaos/config', (req, res) => {
  if (req.query.reload === 'true') { try { reloadCinemaosConfig(); return res.json({ ok: true }); } catch (e: any) { return res.status(500).json({ ok: false, error: e.message }); } }
  res.json({ ok: true });
});
```

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: zero tsc errors.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts
git commit -m "feat(cinemaos): wire into handleStream (streams + subtitles + reload endpoint)"
```

---

### Task 6: Allowlist CDN hosts, deploy, end-to-end verification

**Files:**
- Modify: `config/allowed-domains.json`

- [ ] **Step 1: Pre-seed common CinemaOS CDN hosts**

Add to the `domains` array (substring-matched): `"1shows.app"`, `"kkphimplayer"`, `"cinemaos.workers.dev"`, `"shegu.org"`, `"swclb.com"`, `"oravix"`, `"lordflix"`. (Unknown shards that appear later are caught by the Telegram bot's "add to whitelist" alert.)

- [ ] **Step 2: Build + deploy**

Run: `npm run build && docker compose up -d --build loostream`
Expected: container recreates and starts.

- [ ] **Step 3: End-to-end — movie with subtitles**

Run (build a config blob with a TMDB key + `proxy:local`, as used in prior testing):
```bash
CFG=$(python3 -c "import base64,json;print(base64.b64encode(json.dumps({'tmdbKey':'<KEY>','proxy':'local'}).encode()).decode())")
curl -sS -m 70 "http://localhost:7002/$CFG/stream/movie/tt32565993.json" | python3 -c "import sys,json;d=json.load(sys.stdin);[print(s['name'],'| subs:',len(s.get('subtitles',[]))) for s in d['streams'] if 'CinemaOS' in s['name']]"
```
Expected: one or more `CinemaOS …` streams for "The Sheep Detectives", at least one with `subs > 0`.

- [ ] **Step 4: End-to-end — playback chain**

Take a CinemaOS stream URL from the response, fetch it through `/proxy/manifest`, then pull one segment. Expected: manifest rewrites to `/proxy/*`, segment returns HTTP 200. (If a CDN host is blocked, the log shows `Domain not whitelisted: <host>` — add it to `config/allowed-domains.json` and `curl .../proxy/domains?reload=true`.)

- [ ] **Step 5: End-to-end — series**

Run for a known show (e.g. Stranger Things `tmdb:66732:1:1`) and confirm `CinemaOS` streams appear.

- [ ] **Step 6: Commit**

```bash
git add config/allowed-domains.json
git commit -m "chore(cinemaos): pre-seed CDN hosts in allowlist"
```

---

## Self-Review notes

- **Spec coverage:** signing (T1), decryption (T1), scrape+sources (T2), worker unwrap (T2), subtitles (T2/T5), curated scraper set (config, T1), config hot-reload (T1/T5), series (T2/T5), delivery via proxy (T5), imdbId dependency (T3), metrics (T4), allowlist/Telegram interaction (T6). All covered.
- **No placeholders:** all steps carry real code/commands.
- **Type consistency:** `CinemaosStream`/`CinemaosSubtitle` defined in T2 and consumed verbatim in T5; `getCinemaosStreams` signature identical across T2/T5; `info.imdbId` added in T3 and used in T5.
- **Note on tests:** the repo has no unit-test framework; `scripts/cinemaos-probe.ts` + curl e2e are the verification mechanism, consistent with how the codebase is exercised.

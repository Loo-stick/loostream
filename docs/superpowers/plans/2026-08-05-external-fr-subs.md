# Sous-titres FR externes (OpenSubtitles) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ajouter des sous-titres FR (OpenSubtitles legacy, sans clé) à la ressource `/subtitles`, pour les flux VO (Videasy…).

**Architecture:** Module `src/subtitles.ts` (fetch caché) + endpoint `/extsub/subtitle` (gunzip + SRT→VTT + SSRF) + bloc dans `handleSubtitles`.

**Tech Stack:** TypeScript strict, node:test, `zlib` (gunzip), axios.

## Global Constraints
- Commits FR conventionnels, `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- API legacy `rest.opensubtitles.org` : UA requise, pas de clé. Liens `dl.opensubtitles.org` = SRT gzippé.
- SSRF : `/extsub/subtitle` n'accepte que `https://*.opensubtitles.org`.
- Ne jamais throw côté endpoint/module (repli liste vide / 502).

---

### Task 1 : Module `src/subtitles.ts` + test

**Files:** Create `src/subtitles.ts`, `src/subtitles.test.ts`

**Interfaces produites :**
- `interface ExtSub { url: string; name: string; downloads: number }`
- `getFrenchSubtitles(imdbId: string, season?: number, episode?: number): Promise<ExtSub[]>`
- `parseOpenSubtitles(data: any[]): ExtSub[]` (pur, testable — le tri/top-3/filtre)

- [ ] **Step 1 : test d'abord** (`src/subtitles.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { parseOpenSubtitles } from './subtitles';

test('parseOpenSubtitles : filtre srt, trie par téléchargements, top 3', () => {
  const raw = [
    { SubFormat: 'srt', SubDownloadLink: 'https://dl.opensubtitles.org/a', SubDownloadsCnt: '100', MovieReleaseName: 'A' },
    { SubFormat: 'sub', SubDownloadLink: 'https://dl.opensubtitles.org/x', SubDownloadsCnt: '999', MovieReleaseName: 'X' }, // non-srt -> exclu
    { SubFormat: 'srt', SubDownloadLink: 'https://dl.opensubtitles.org/b', SubDownloadsCnt: '5000', SubFileName: 'B.srt' },
    { SubFormat: 'srt', SubDownloadLink: 'https://dl.opensubtitles.org/c', SubDownloadsCnt: '300', MovieReleaseName: 'C' },
    { SubFormat: 'srt', SubDownloadLink: 'https://dl.opensubtitles.org/d', SubDownloadsCnt: '10', MovieReleaseName: 'D' },
  ];
  const out = parseOpenSubtitles(raw);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(s => s.downloads), [5000, 300, 100]); // trié desc, top 3
  assert.equal(out[0].name, 'B.srt');
});

test('parseOpenSubtitles : entrée non-tableau -> []', () => {
  assert.deepEqual(parseOpenSubtitles(null as any), []);
});
```

- [ ] **Step 2 : lancer, voir échouer** — `node --import tsx --test src/subtitles.test.ts` → FAIL.

- [ ] **Step 3 : implémenter** (`src/subtitles.ts`)

```ts
import axios from 'axios';
import { cached } from './cache';

// Sous-titres FR externes via l'API LEGACY d'OpenSubtitles (rest.opensubtitles.org) :
// sans clé, sans quota, liens de téléchargement directs (SRT gzippé). Complète les
// sources VO (Videasy) qui ne portent pas de FR. Servi ensuite via /extsub/subtitle.

const OS_BASE = 'https://rest.opensubtitles.org';
const OS_UA = 'LooStream/1.0 (+subtitles)'; // l'API legacy exige un User-Agent
const TTL_MS = 12 * 60 * 60 * 1000;
const TOP_N = 3;

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
```

- [ ] **Step 4 : lancer, voir passer** — PASS (2 tests).
- [ ] **Step 5 : commit** — `feat(subs): module OpenSubtitles legacy (FR, sans clé)`.

---

### Task 2 : Endpoint `/extsub/subtitle` (gunzip + SRT→VTT + SSRF)

**Files:** Modify `src/index.ts`

- [ ] **Step 1 :** ajouter l'import zlib en tête : `import * as zlib from 'zlib';` (si absent).
- [ ] **Step 2 :** ajouter l'endpoint près des autres `/X/subtitle` (après `/videasy/subtitle`, ~l.1981) :

```ts
// Sous-titres FR externes (OpenSubtitles legacy) : télécharge le SRT (gzippé),
// gunzip, convertit SRT->VTT, sert text/vtt. SSRF : uniquement *.opensubtitles.org.
app.get('/extsub/subtitle', async (req, res) => {
  const u = String(req.query.url || '');
  let parsed: URL;
  try { parsed = new URL(u); } catch { res.status(400).end(); return; }
  if (parsed.protocol !== 'https:' || !/(^|\.)opensubtitles\.org$/i.test(parsed.hostname)) {
    res.status(403).end(); return;
  }
  try {
    const resp = await axios.get<ArrayBuffer>(u, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'LooStream/1.0 (+subtitles)' },
      maxContentLength: 5 * 1024 * 1024, maxBodyLength: 5 * 1024 * 1024,
    });
    let buf = Buffer.from(resp.data);
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch { /* pas gzip */ } }
    const srt = buf.toString('utf-8').replace(/\r+/g, '');
    const vtt = 'WEBVTT\n\n' + srt
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
      .replace(/[ \t]*-->[ \t]*/g, ' --> ');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(vtt);
  } catch { res.status(502).end(); }
});
```

- [ ] **Step 3 : build** — `npm run build` → OK.
- [ ] **Step 4 : commit** — `feat(subs): endpoint /extsub/subtitle (gunzip + SRT->VTT, SSRF opensubtitles)`.

---

### Task 3 : Câbler `handleSubtitles`

**Files:** Modify `src/index.ts`

**Interfaces consommées :** `getFrenchSubtitles` de `./subtitles`.

- [ ] **Step 1 :** import `import { getFrenchSubtitles } from './subtitles';`.
- [ ] **Step 2 :** ajouter, dans `handleSubtitles`, après le bloc Videasy (avant le `console.log('[Subtitles] ...')` l.1374) :

```ts
    // Sous-titres FR EXTERNES (OpenSubtitles legacy) — complètent les flux VO
    // (Videasy…) qui ne portent pas de FR. Toujours proposés ; ignorés sur du VF.
    try {
      if (info.imdbId) {
        const ext = await getFrenchSubtitles(
          info.imdbId,
          type === 'series' ? parsed.season : undefined,
          type === 'series' ? parsed.episode : undefined,
        );
        ext.forEach((s, i) => {
          const su = new URL('/extsub/subtitle', baseUrl);
          su.searchParams.set('url', s.url);
          subtitles.push({ id: `opensubtitles-fr-${i}`, url: signUrl(su).toString(), lang: 'fre' });
        });
      }
    } catch (e: any) {
      console.log('[Subtitles] OpenSubtitles:', (e?.message || '').slice(0, 80));
    }
```

- [ ] **Step 3 : build** — `npm run build` → OK.
- [ ] **Step 4 : commit** — `feat(subs): pistes FR OpenSubtitles ajoutées à la ressource /subtitles`.

---

### Task 4 : Vérification réelle + déploiement

- [ ] **Step 1 : tests complets** — `npm test` → tout vert.
- [ ] **Step 2 : build + déploiement** — `npm run build && docker compose up -d --build loostream`.
- [ ] **Step 3 : vérif module en conteneur** :
  ```bash
  docker exec loostream node -e 'require("/app/dist/subtitles").getFrenchSubtitles("tt6263850").then(r=>console.log("FR subs:",r.length,r.map(s=>s.downloads)))'
  ```
  Attendu : 3 sous-titres FR (top downloads).
- [ ] **Step 4 : vérif endpoint** — récupérer un `SubDownloadLink` de la réponse ci-dessus, puis :
  ```bash
  curl -s "http://localhost:7002/extsub/subtitle?url=<lien>" | head -3
  ```
  Attendu : commence par `WEBVTT`, timings en `.` (VTT).
- [ ] **Step 5 : vérif ressource** — `curl -s http://localhost:7002/subtitles/movie/tt6263850.json` → doit contenir des pistes `lang:"fre"` id `opensubtitles-fr-*`.
- [ ] **Step 6 :** validation utilisateur dans Stremio (choisir « Français » sur un flux Videasy VO).

## Self-Review (fait)
- **Couverture spec** : module (T1), endpoint gunzip/SRT→VTT/SSRF (T2), câblage handleSubtitles (T3), vérif (T4). ✓
- **Placeholders** : aucun — code réel partout. ✓
- **Types** : `ExtSub`/`getFrenchSubtitles`/`parseOpenSubtitles` cohérents T1↔T3. ✓
- **Sécurité** : SSRF hostname-locked opensubtitles.org ; maxContentLength borne le download ; jamais de throw. ✓

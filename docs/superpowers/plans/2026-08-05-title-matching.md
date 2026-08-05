# Matcher de titre strict — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remplacer les matchings par sous-chaîne des sources keyées par titre par un module partagé strict (token-set + année), précision d'abord — plus jamais le mauvais film.

**Architecture:** Module pur `src/matching.ts` (aucune I/O, testable) consommé par Coflix, VoirAnime, NetMirror, MovieBox. Chaque scraper construit des `Candidate{title, year?, item}` et délègue à `accepts`/`pickBest`.

**Tech Stack:** TypeScript strict, node:test (+ tsx).

## Global Constraints

- Commits en **français**, conventionnels, terminés par `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Précision d'abord** : en cas de doute, renvoyer 0 plutôt que le mauvais film.
- Ne PAS toucher aux sources tmdbId-keyées (VoirDrama/Wiflix/FrenchStream-API/Movix/StreamFlix/Videasy).
- FrenchStream repli-scraping : **hors périmètre** — il confirme déjà par tmdbId (`tagz "f-{id}"`, `frenchstream.ts:351-354`), donc précis. Noté ici pour mémoire.
- `npm run build` local avant tout rebuild conteneur.

---

### Task 1 : Module `src/matching.ts` + tests (TDD)

**Files:** Create `src/matching.ts`, `src/matching.test.ts`

**Interfaces produites :**
- `interface Wanted { titles: string[]; year?: number }`
- `interface Candidate<T> { title: string; year?: number; item: T }`
- `normalizeTokens(s): string[]`, `titlesMatch(wantedTitles, candidateTitle): boolean`
- `type YearVerdict = 'exact'|'close'|'unknown'|'mismatch'`, `yearVerdict(w, c): YearVerdict`
- `accepts<T>(wanted, c): boolean`, `pickBest<T>(wanted, candidates): Candidate<T>|null`

- [ ] **Step 1 : test d'abord** (`src/matching.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeTokens, titlesMatch, yearVerdict, accepts, pickBest } from './matching';

test('normalizeTokens : accents, articles, tags de version et année retirés', () => {
  assert.deepEqual(normalizeTokens('Le Fabuleux Destin (2001)'), ['fabuleux', 'destin']);
  assert.deepEqual(normalizeTokens('Happy End VOSTFR'), ['happy', 'end']);
});

test('titlesMatch : égalité de token-set, pas de sous-chaîne', () => {
  assert.equal(titlesMatch(['Happy End'], 'Happy End'), true);
  assert.equal(titlesMatch(['Happy End'], 'My Happy Ending'), false); // le bug d'origine
  assert.equal(titlesMatch(['Happy End'], 'Happy End 2'), false);      // sequel distinct
  assert.equal(titlesMatch(['Projet Dernière Chance', 'Project Hail Mary'], 'Project Hail Mary'), true);
});

test('yearVerdict : exact / close(±1) / unknown / mismatch', () => {
  assert.equal(yearVerdict(1999, 1999), 'exact');
  assert.equal(yearVerdict(1999, 2000), 'close');
  assert.equal(yearVerdict(1999, undefined), 'unknown');
  assert.equal(yearVerdict(1999, 2023), 'mismatch');
});

test('accepts : rejette mauvais titre ET mauvaise année, garde titre exact sans année', () => {
  const w = { titles: ['Happy End'], year: 1999 };
  assert.equal(accepts(w, { title: 'My Happy Ending', year: 2023, item: 1 }), false);
  assert.equal(accepts(w, { title: 'Happy End', year: 2017, item: 2 }), false); // même titre, autre année
  assert.equal(accepts(w, { title: 'Happy End', year: 1999, item: 3 }), true);
  assert.equal(accepts(w, { title: 'Happy End', year: undefined, item: 4 }), true); // année inconnue OK
});

test('pickBest : année exacte préférée', () => {
  const w = { titles: ['Happy End'], year: 1999 };
  const best = pickBest(w, [
    { title: 'Happy End', year: undefined, item: 'unknown' },
    { title: 'Happy End', year: 2000, item: 'close' },
    { title: 'Happy End', year: 1999, item: 'exact' },
  ]);
  assert.equal(best?.item, 'exact');
});
```

- [ ] **Step 2 : lancer, voir échouer** — `node --import tsx --test src/matching.test.ts` → FAIL (module absent).

- [ ] **Step 3 : implémenter** (`src/matching.ts`)

```ts
// Matcher de titre PARTAGÉ, précision d'abord (voir docs/.../2026-08-05-title-matching-design.md).
// Pur, sans I/O : chaque scraper par titre construit des Candidate et délègue la sélection.

export interface Wanted { titles: string[]; year?: number }
export interface Candidate<T> { title: string; year?: number; item: T }
export type YearVerdict = 'exact' | 'close' | 'unknown' | 'mismatch';

// Articles/liaisons + tags de version + marqueurs saison : bruit à ignorer pour comparer.
const STOPWORDS = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'de', 'des', 'du', 'the', 'a', 'an', 'of', 'and', 'et',
  'vf', 'vostfr', 'vost', 'vo', 'multi', 'french', 'truefrench',
  'saison', 'season', 'episode', 'ep',
]);

export function normalizeTokens(s: string): string[] {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // diacritiques
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t) && !/^(19|20)\d\d$/.test(t)); // retire les tokens ANNÉE
}

function tokenSet(s: string): Set<string> { return new Set(normalizeTokens(s)); }
function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** ÉGALITÉ de token-set avec au moins un titre voulu (FR/original). Pas de sous-chaîne. */
export function titlesMatch(wantedTitles: string[], candidateTitle: string): boolean {
  const c = tokenSet(candidateTitle);
  if (c.size === 0) return false;
  return wantedTitles.some(w => { const ws = tokenSet(w); return ws.size > 0 && setEq(ws, c); });
}

export function yearVerdict(wanted: number | undefined, candidate: number | undefined): YearVerdict {
  if (!wanted || !candidate) return 'unknown';
  const d = Math.abs(wanted - candidate);
  return d === 0 ? 'exact' : d <= 1 ? 'close' : 'mismatch';
}

/** Précision d'abord : titre token-set exact ET année non contradictoire. */
export function accepts<T>(wanted: Wanted, c: Candidate<T>): boolean {
  return titlesMatch(wanted.titles, c.title) && yearVerdict(wanted.year, c.year) !== 'mismatch';
}

const YEAR_RANK: Record<YearVerdict, number> = { exact: 0, close: 1, unknown: 2, mismatch: 3 };
export function pickBest<T>(wanted: Wanted, candidates: Candidate<T>[]): Candidate<T> | null {
  const accepted = candidates.filter(c => accepts(wanted, c));
  if (accepted.length === 0) return null;
  const norm = (s: string) => normalizeTokens(s).join(' ');
  const wantedNorms = wanted.titles.map(norm);
  accepted.sort((a, b) => {
    const yr = YEAR_RANK[yearVerdict(wanted.year, a.year)] - YEAR_RANK[yearVerdict(wanted.year, b.year)];
    if (yr !== 0) return yr;
    // à année égale, l'égalité de chaîne normalisée (ordre inclus) départage
    return (wantedNorms.includes(norm(a.title)) ? 0 : 1) - (wantedNorms.includes(norm(b.title)) ? 0 : 1);
  });
  return accepted[0];
}
```

- [ ] **Step 4 : lancer, voir passer** — `node --import tsx --test src/matching.test.ts` → PASS (5 tests).

- [ ] **Step 5 : commit**

```bash
git add src/matching.ts src/matching.test.ts
git commit -m "feat(matching): module de matching de titre strict (token-set + année, précision d'abord)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2 : Câbler Coflix (année du suggest + accepts)

**Files:** Modify `src/scrapers/coflix.ts`, `src/index.ts` (passer l'année).

**Interfaces consommées :** `Wanted`, `accepts` de `../matching`.

- [ ] **Step 1 : capturer l'année du suggest.** Dans `coflix.ts` :
  - Import : `import { Wanted, accepts } from '../matching';`
  - `interface SuggestItem` (l.81) : ajouter `year?: number`.
  - `ITEM_RX` (l.83) : ajouter la capture optionnelle de l'année (2ᵉ `.dot`). Remplacer par :
    ```ts
    const ITEM_RX = /<a class="item"\s+href="([^"]+\/ep-(\d+))"[\s\S]*?data-jp="([^"]*)"[\s\S]*?<span class="dot">([^<]+)<\/span>(?:[\s\S]{0,140}?<span class="dot">\s*((?:19|20)\d\d)\s*<\/span>)?/gi;
    ```
  - `searchSuggest` (l.123) : `items.push({ episodeId: m[2], slug, title: m[3], type: (m[4] || '').trim(), year: m[5] ? Number(m[5]) : undefined });`

- [ ] **Step 2 : passer l'année du caller.** `getCoflixStreams` (l.181) : ajouter param `year?: number` ; le propager à `fetchCoflixStreams`. Dans `src/index.ts` (appel Coflix, l.846) : ajouter `info.year ? Number(info.year) : undefined` en argument. `fetchCoflixStreams` (l.205) : ajouter le param `year`.

- [ ] **Step 3 : remplacer le match par sous-chaîne.** Dans `fetchCoflixStreams`, remplacer le bloc l.216-232 :
  ```ts
  const targets = titles.map(normalize);
  // ...
    const cleanSlug = normalize(it.slug.replace(/saison[-\s]?\d+/i, '').replace(/(vostfr|truefrench|vf|french)$/i, ''));
    const ok = targets.some(t => t && (cleanSlug.includes(t) || t.includes(cleanSlug)));
    if (!ok) continue;
  ```
  par :
  ```ts
  const wanted: Wanted = { titles, year };
  // ... (dans la boucle, après les filtres type/saison) :
    if (!accepts(wanted, { title: it.title, year: it.year, item: it })) continue;
  ```
  (retirer `targets` et `cleanSlug` devenus inutiles.)

- [ ] **Step 4 : build** — `npm run build` → OK.

- [ ] **Step 5 : vérif RÉELLE** — déployer (`docker compose up -d --build loostream`) puis, en conteneur :
  ```bash
  docker exec loostream node -e 'require("/app/dist/scrapers/coflix").getCoflixStreams("movie",{useMediaFlow:false,...},undefined,undefined,"Happy End","Happy End",1999).then(r=>console.log("Happy End 1999 ->",r.length,"stream(s)"))'
  ```
  Attendu : **0** (au lieu de « My Happy Ending »). Et un titre valide (ex. Project Hail Mary via son vrai titre) → >0. (Adapter la signature exacte au param `year` ajouté.)

- [ ] **Step 6 : commit**

```bash
git add src/scrapers/coflix.ts src/index.ts
git commit -m "fix(coflix): matching strict (token-set + année du suggest) au lieu de la sous-chaîne

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3 : Câbler VoirAnime (titre strict, drop du préfixe)

**Files:** Modify `src/scrapers/voiranime.ts`

- [ ] **Step 1 :** import `import { titlesMatch } from '../matching';`.
- [ ] **Step 2 :** dans `searchSite` (l.117-136), remplacer le filtre préfixe l.128 :
  ```ts
  const norm = normalizeTitle(name);
  if (!norm || (norm !== target && !norm.startsWith(target) && !target.startsWith(norm))) continue;
  ```
  par un match strict token-set (l'anime n'expose pas d'année fiable → titre seul) :
  ```ts
  if (!titlesMatch(titles, name)) continue;
  ```
  `searchSite` reçoit aujourd'hui un seul `title` ; le faire recevoir `titles: string[]` (titre + original, déjà dispo dans `getVoirAnimeStreams`) pour matcher FR **et** original. Retirer la variable `target` devenue inutile.
- [ ] **Step 3 : build** — `npm run build` → OK.
- [ ] **Step 4 : commit** — `fix(voiranime): matching strict token-set (fin du match par préfixe)`.

---

### Task 4 : Câbler NetMirror (token-set, drop contains-fallback)

**Files:** Modify `src/scrapers/netmirror.ts`

- [ ] **Step 1 :** import `import { titlesMatch } from '../matching';`.
- [ ] **Step 2 :** remplacer la sélection l.151-156 :
  ```ts
  const target = normalizeTitle(title);
  let best = results.find(r => normalizeTitle(r.t) === target);
  if (!best) best = results.find(r => { const n = normalizeTitle(r.t); return n.startsWith(target) || target.startsWith(n); });
  return best?.id || null;
  ```
  par (les résultats NetMirror n'ont pas d'année → titre strict ; catalogue anglophone → titre unique suffit) :
  ```ts
  const best = results.find(r => titlesMatch([title], r.t));
  return best?.id || null;
  ```
- [ ] **Step 3 : build + commit** — `fix(netmirror): sélection stricte token-set (fin du repli contains)`.

---

### Task 5 : Câbler MovieBox (accepts + tiebreak dub anglais conservé)

**Files:** Modify `src/scrapers/moviebox.ts`

- [ ] **Step 1 :** import `import { accepts } from '../matching';`.
- [ ] **Step 2 :** remplacer le scoring l.159-176 par un filtrage `accepts` (année dispo côté MovieBox) puis le tiebreak dub anglais existant :
  ```ts
  const wanted = { titles: [title], year: year ? Number(year) : undefined };
  const cands = subjects
    .filter(s => s?.subjectId && Number(s.subjectType) === wantType)
    .map(s => ({
      s,
      year: Number(String(s.releaseDate || s.year || '').match(/\d{4}/)?.[0]) || undefined,
      english: /\benglish\b/.test(String(s.title).toLowerCase()),
    }))
    .filter(c => accepts(wanted, { title: c.s.title, year: c.year, item: c.s }))
    .sort((a, b) => Number(a.english) - Number(b.english)); // dub anglais en dernier
  return cands[0]?.s?.subjectId || null;
  ```
  (MovieBox ne reçoit qu'un `title` anglais — cohérent avec son catalogue.)
- [ ] **Step 3 : build + commit** — `fix(moviebox): sélection via accepts partagé (année + titre stricts), dub anglais en dernier`.

---

### Task 6 : Build + vérification d'intégration + déploiement

- [ ] **Step 1 : tests complets** — `npm test` → tout vert (incl. 5 nouveaux `matching`).
- [ ] **Step 2 : build + déploiement** — `npm run build && docker compose up -d --build loostream`.
- [ ] **Step 3 : vérif live** — via un vrai lancement Stremio (ou logs admin), tester :
  - « Happy End » (1999) → **plus** de faux « My Happy Ending » côté Coflix (Coflix renvoie 0 ou le bon film si présent).
  - Un titre mainstream (Project Hail Mary) → sources VF Coflix **toujours présentes** (pas de sur-rejet).
- [ ] **Step 4 :** si tout est bon, prêt pour bump/tag (décidé avec l'utilisateur).

## Self-Review (fait)
- **Couverture spec** : module (T1), Coflix (T2), VoirAnime (T3), NetMirror (T4), MovieBox (T5), FrenchStream = hors périmètre justifié (tagz). ✓
- **Placeholders** : aucun — code réel à chaque étape. ✓
- **Cohérence des types** : `Wanted`/`Candidate`/`accepts`/`pickBest`/`titlesMatch`/`yearVerdict` identiques entre T1 (déf) et T2-T5 (usage). ✓
- **Risque de sur-rejet** (précision d'abord assumé) : vérif live T6 step 3 sur un mainstream pour confirmer qu'on ne casse pas les bons matchs.

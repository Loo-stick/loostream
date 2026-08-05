# Matching de titre strict (précision d'abord) — Design & Plan

**Goal:** Ne plus jamais proposer le mauvais film sur les sources keyées par titre. Aujourd'hui Coflix (et les autres voies par titre) matchent par **sous-chaîne sans année** → « Happy End » (1999) ramène « My Happy Ending » (2023). On remplace ça par un **matcher partagé strict** (token-set + année), précision d'abord.

**Contexte (exploration) :**
- La plupart des sources sont déjà **tmdbId-keyées** et robustes : VoirDrama (`api.movix/drama/tv/{tmdbId}`), Wiflix, FrenchStream (API). Elles ne sont PAS le problème.
- Les voies **par titre** (fragiles) : **Coflix** (aucune route tmdbId — `404` sur Movix), **VoirAnime**, le **repli-scraping** de FrenchStream (quand l'API renvoie 0), et la **recherche** NetMirror/MovieBox.
- Bug exact (Coflix `src/scrapers/coflix.ts:231`) : `cleanSlug.includes(t) || t.includes(cleanSlug)` → `"myhappyending".includes("happyend")` = vrai.
- **L'année est disponible gratuitement** dans le HTML du suggest Coflix (`2023` à côté de chaque item) — pas de requête supplémentaire.

## Architecture

Un module pur **`src/matching.ts`**, testable, sans I/O. Chaque scraper par titre construit ses candidats `{ title, year?, item }` et délègue la sélection au module. Aucun scraper ne roule plus son propre matching.

## API du module (`src/matching.ts`)

```ts
export interface Wanted { titles: string[]; year?: number; }           // titres FR + original, année TMDB
export interface Candidate<T> { title: string; year?: number; item: T; }

export function normalizeTokens(s: string): string[];                    // sans accents, minuscule, alphanum ;
                                                                        //   retire articles/tags de version/années
export function titlesMatch(wantedTitles: string[], candidateTitle: string): boolean; // ÉGALITÉ de token-set
export type YearVerdict = 'exact' | 'close' | 'unknown' | 'mismatch';
export function yearVerdict(wanted: number | undefined, candidate: number | undefined): YearVerdict; // |Δ|≤1 = close
export function pickBest<T>(wanted: Wanted, candidates: Candidate<T>[]): Candidate<T> | null;
export function accepts<T>(wanted: Wanted, c: Candidate<T>): boolean;    // prédicat unitaire (filtrage multi-versions)
```

### Normalisation (`normalizeTokens`)
NFD → retire diacritiques → minuscule → remplace tout non `[a-z0-9]` par espace → tokens. **Retire** : articles/liaisons (`le la les l un une de des du the a an of and et`), tags de version (`vf vostfr vost truefrench vo multi french`), marqueurs (`saison season episode ep`), et **tokens année** (`/^(19|20)\d\d$/`). Garde les autres nombres (un « Part 2 » reste distinct d'un « Part 1 »).

### Titre (`titlesMatch`) — précision d'abord
`true` si le token-set du candidat est **égal** (mêmes éléments) au token-set d'**au moins un** titre voulu. Plus de sous-chaîne, plus de sous/sur-ensemble. Ex. `{happy,end}` == `{happy,end}` ✓ ; ≠ `{my,happy,ending}` ✗ ; ≠ `{happy,end,2}` ✗ (sequel).

### Année (`yearVerdict`)
`exact` si égales ; `close` si `|Δ| ≤ 1` (slack date de sortie vs année du site) ; `unknown` si l'une manque ; `mismatch` si `|Δ| > 1`.

### Sélection (`accepts` / `pickBest`) — précision d'abord
`accepts` = `titlesMatch(...)` **ET** `yearVerdict(...) !== 'mismatch'`. Conséquences :
- année connue des deux côtés et écart > 1 → **rejet** (tue « même titre, autre année ») ;
- titre non-égal en token-set → **rejet** (tue « My Happy Ending ») ;
- pas d'année dispo + titre token-set exact → **accepté** (le titre strict seul suffit).

`pickBest` = parmi les `accepts`, trie par `(exact > close > unknown)` puis titre exact (chaîne normalisée identique), renvoie le meilleur ou `null`.

## Câblage par scraper

| Source | Année dispo ? | Changement |
|---|---|---|
| **Coflix** | ✅ (HTML suggest) | Capturer `year` dans `SuggestItem` ; remplacer le `.includes` (l.231) par `accepts()` ; garder le groupement une-fiche-par-version en filtrant d'abord sur `accepts`. |
| **VoirAnime** | selon la recherche | Remplacer sa sélection par `accepts`/`pickBest` (année si le listing l'expose, sinon titre strict). |
| **FrenchStream** (repli scraping) | selon la page | Idem sur la sélection du repli site (l'API tmdbId reste prioritaire, inchangée). |
| **NetMirror / MovieBox** | selon l'API | Remplacer la sélection du résultat de recherche par `pickBest`. |

## Non-goals (YAGNI)
- Pas de fuzzy/Levenshtein ni de seuil de similarité (précision d'abord → égalité stricte).
- Pas de re-vérification TMDB post-match (redondant avec l'année).
- On ne touche pas aux sources tmdbId-keyées (VoirDrama/Wiflix/FrenchStream-API/Movix/StreamFlix/Videasy) : elles sont déjà justes.
- Conséquence assumée : sur un titre générique dont le site n'a PAS la bonne année, on renverra **0 source** (mieux que le mauvais film).

## Plan d'implémentation (ordre)
1. `src/matching.ts` + `src/matching.test.ts` (module pur, cas « Happy End » + désambiguïsation année + égalité stricte). TDD.
2. Câbler **Coflix** (capturer l'année du suggest + `accepts`) ; vérifier en réel que « Happy End » → 0 (au lieu de « My Happy Ending »).
3. Câbler **VoirAnime**, **repli FrenchStream**, **NetMirror/MovieBox**.
4. Build + tests + déploiement + vérif.

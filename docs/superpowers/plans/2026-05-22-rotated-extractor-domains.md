# Détection & ajout assisté des domaines d'extracteurs rotés — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Détecter les embeds posés sur des domaines de file-hosts non reconnus, et permettre au bot Telegram de proposer l'ajout du domaine au bon extracteur d'un clic, sans rebuild.

**Architecture:** Les listes de domaines d'extracteurs sont externalisées dans `config/extractor-domains.json` (hot-reloadé). `flemmix` et `movix` loggent les hôtes non reconnus avec leur label serveur. Le bot Telegram grep ces logs, déduit l'extracteur depuis le label, propose un bouton, et écrit dans le JSON + déclenche un reload.

**Tech Stack:** TypeScript (Node 22, CommonJS, `tsc`), Express, bot Node en JS pur, runner de test natif `node --test` via `tsx`.

**Référence spec :** `docs/superpowers/specs/2026-05-22-rotated-extractor-domains-design.md`

---

## Notes transverses

- Le repo a des modifications non committées **sans rapport** avec ce travail
  (`config/allowed-domains.json`, `config/movix-endpoints.json`,
  `config/flemmix-endpoints.json`). **Ne jamais faire `git add -A`.** Chaque
  commit liste explicitement ses fichiers.
- Travailler sur la branche `feat/extractor-domain-auto-add` (déjà créée).
- Après chaque tâche touchant du TypeScript : `npm run build` doit passer.

## File Structure

| Fichier | Rôle |
|---|---|
| `src/extractors/index.ts` *(modifié)* | Données de domaines, `mergeExtractorDomains`, `loadExtractorDomains`, `detectExtractor` dynamique, `fs.watch`, exports reload |
| `src/extractors/index.test.ts` *(créé)* | Tests unitaires des fonctions pures d'extraction de domaines |
| `src/scrapers/flemmix.ts` *(modifié)* | Log `Unrecognized host` pour les embeds rejetés |
| `src/scrapers/movix.ts` *(modifié)* | Log `Unrecognized host` pour les embeds rejetés |
| `src/index.ts` *(modifié)* | Endpoint `GET /api/extractor-domains?reload=true` |
| `config/extractor-domains.json` *(créé)* | Source de vérité runtime des domaines, éditée par le bot |
| `telegram-bot-domains.js` *(créé)* | Helpers purs du bot (déduction label, parsing log, mutation config) |
| `telegram-bot-domains.test.js` *(créé)* | Tests unitaires des helpers du bot |
| `telegram-bot.js` *(modifié)* | Surveillance log, alerte Telegram, callbacks, écriture config |
| `Dockerfile.telegram` *(modifié)* | Copie le nouveau helper dans l'image du bot |
| `package.json` *(modifié)* | Dépendance `tsx`, script `test` |
| `tsconfig.json` *(modifié)* | Exclut les fichiers `*.test.ts` du build |

---

## Task 1: Infrastructure de test

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Ajouter le script `test` et la devDependency `tsx` dans `package.json`**

Dans `package.json`, section `scripts`, ajouter la ligne `test` :

```json
  "scripts": {
    "build": "tsc && node -e \"['configure.html','admin.html','login.html'].forEach(f=>require('fs').copyFileSync('src/'+f,'dist/'+f))\"",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "test": "node --import tsx --test \"src/**/*.test.ts\" \"*.test.js\""
  },
```

- [ ] **Step 2: Installer `tsx`**

Run: `npm install --save-dev tsx`
Expected: `tsx` apparaît dans `devDependencies` de `package.json`, `package-lock.json` mis à jour, exit 0.

- [ ] **Step 3: Exclure les fichiers de test du build TypeScript**

Dans `tsconfig.json`, remplacer la ligne `exclude` :

```json
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
```

- [ ] **Step 4: Vérifier le runner avec un test jetable**

Créer `src/extractors/_smoke.test.ts` :

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('le runner de test fonctionne', () => {
  assert.equal(1 + 1, 2);
});
```

Run: `npm test`
Expected: `1 passing` (ou `tests 1`, `pass 1`), exit 0.

- [ ] **Step 5: Supprimer le test jetable**

Run: `rm src/extractors/_smoke.test.ts`

- [ ] **Step 6: Vérifier que le build passe toujours**

Run: `npm run build`
Expected: exit 0, pas d'erreur `tsc`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "build: runner de test node --test via tsx"
```

---

## Task 2: Domaines par défaut, fusion, détection pure

Ajout **purement additif** dans `src/extractors/index.ts` : les anciennes
constantes et l'ancien `detectExtractor` restent en place (supprimés en Task 3).

**Files:**
- Modify: `src/extractors/index.ts`
- Create: `src/extractors/index.test.ts`

- [ ] **Step 1: Écrire les tests**

Créer `src/extractors/index.test.ts` :

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EXTRACTOR_DOMAINS,
  EXTRACTOR_IDS,
  mergeExtractorDomains,
  detectExtractorIn,
} from './index';

test('EXTRACTOR_IDS contient les 12 extracteurs', () => {
  assert.equal(EXTRACTOR_IDS.length, 12);
});

test('mergeExtractorDomains: objet complet valide utilisé tel quel', () => {
  const input = { ...DEFAULT_EXTRACTOR_DOMAINS, voe: ['custom-voe.test'] };
  const merged = mergeExtractorDomains(input);
  assert.deepEqual(merged.voe, ['custom-voe.test']);
  assert.deepEqual(merged.uqload, DEFAULT_EXTRACTOR_DOMAINS.uqload);
});

test('mergeExtractorDomains: clé absente retombe sur le défaut', () => {
  const merged = mergeExtractorDomains({ voe: ['x.test'] });
  assert.deepEqual(merged.voe, ['x.test']);
  assert.deepEqual(merged.doodstream, DEFAULT_EXTRACTOR_DOMAINS.doodstream);
});

test('mergeExtractorDomains: entrée non-objet renvoie tous les défauts', () => {
  for (const bad of [null, undefined, 42, 'str', []]) {
    assert.deepEqual(mergeExtractorDomains(bad), DEFAULT_EXTRACTOR_DOMAINS);
  }
});

test('mergeExtractorDomains: valeur non-tableau retombe sur le défaut', () => {
  const merged = mergeExtractorDomains({ voe: 'not-an-array' });
  assert.deepEqual(merged.voe, DEFAULT_EXTRACTOR_DOMAINS.voe);
});

test('mergeExtractorDomains: tableau avec non-strings retombe sur le défaut', () => {
  const merged = mergeExtractorDomains({ voe: ['ok', 123] });
  assert.deepEqual(merged.voe, DEFAULT_EXTRACTOR_DOMAINS.voe);
});

test('mergeExtractorDomains: clés inconnues ignorées', () => {
  const merged = mergeExtractorDomains({ bogus: ['x'], voe: ['v.test'] });
  assert.equal('bogus' in merged, false);
  assert.deepEqual(merged.voe, ['v.test']);
});

test('detectExtractorIn: reconnaît un domaine voe connu', () => {
  assert.equal(
    detectExtractorIn('https://vidara.to/e/abc', DEFAULT_EXTRACTOR_DOMAINS),
    'voe',
  );
});

test('detectExtractorIn: hôte inconnu renvoie null', () => {
  assert.equal(
    detectExtractorIn('https://kathyinformationwhether.com/e/x', DEFAULT_EXTRACTOR_DOMAINS),
    null,
  );
});

test('detectExtractorIn: URL invalide renvoie null', () => {
  assert.equal(detectExtractorIn('pas une url', DEFAULT_EXTRACTOR_DOMAINS), null);
});

test('detectExtractorIn: respecte un domaine ajouté', () => {
  const domains = {
    ...DEFAULT_EXTRACTOR_DOMAINS,
    voe: [...DEFAULT_EXTRACTOR_DOMAINS.voe, 'kathyinformationwhether.com'],
  };
  assert.equal(
    detectExtractorIn('https://kathyinformationwhether.com/e/x', domains),
    'voe',
  );
});
```

- [ ] **Step 2: Lancer les tests, vérifier l'échec**

Run: `npm test`
Expected: FAIL — `tsx` ne résout pas les exports `DEFAULT_EXTRACTOR_DOMAINS`, `EXTRACTOR_IDS`, `mergeExtractorDomains`, `detectExtractorIn` (non définis).

- [ ] **Step 3: Implémenter le bloc additif**

Dans `src/extractors/index.ts`, insérer le bloc suivant **juste après** la
ligne `type ExtractorId = 'voe' | ... | 'streamwish';` (≈ ligne 49) :

```typescript

export const EXTRACTOR_IDS: ExtractorId[] = [
  'voe', 'uqload', 'doodstream', 'filemoon', 'vidoza', 'vidmoly',
  'streamtape', 'mixdrop', 'sharecloudy', 'lulustream', 'filelions',
  'streamwish',
];

export const DEFAULT_EXTRACTOR_DOMAINS: Record<ExtractorId, string[]> = {
  voe: [
    'voe', 'voe.sx', 'vidara.so', 'vidara.to', 'smoki.cc', 'kinoger.ru',
    'ralphysuccessfull', 'audaciousdefaulthouse', 'launchreliantcleaverriver',
    'reputationsheriffkennethsand', 'greaseball6eventual20', 'timberwoodanotia',
    'yodelswartlike', 'figeterpiazine', 'chromotypic', 'wolfdyslectic',
    'charlestoughrace',
  ],
  uqload: ['uqload'],
  doodstream: ['dood', 'doodstream', 'dsvplay', 'd0o0d', 'dooood', 'd0000d', 'ds2play', 'dood.re'],
  filemoon: ['filemoon', 'filmoon', 'moonlink', 'bysebuho', 'moonplayer'],
  vidoza: ['vidoza'],
  vidmoly: ['vidmoly', 'molystream', 'vidhide'],
  streamtape: ['streamtape', 'strcloud', 'shavetape', 'tapewithadblock'],
  mixdrop: ['mixdrop', 'mdrop', 'mdy48tn97'],
  sharecloudy: ['sharecloudy', 'moovbob', 'moovtop'],
  lulustream: ['luluvdo', 'lulustream', 'lulu.st'],
  filelions: ['filelions', 'minochinos', 'javplaya', 'lionshare'],
  streamwish: ['streamwish', 'hgcloud', 'awish', 'embedwish', 'strwish'],
};

/**
 * Fusionne un JSON parsé (ou n'importe quelle valeur) avec les défauts.
 * Par clé : le tableau du JSON est utilisé s'il est un tableau de strings,
 * sinon le défaut. Entrée non-objet => tous les défauts.
 */
export function mergeExtractorDomains(parsed: unknown): Record<ExtractorId, string[]> {
  const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    ? parsed as Record<string, unknown>
    : {};
  const result = {} as Record<ExtractorId, string[]>;
  for (const id of EXTRACTOR_IDS) {
    const val = obj[id];
    if (Array.isArray(val) && val.every(v => typeof v === 'string')) {
      result[id] = val as string[];
    } else {
      result[id] = DEFAULT_EXTRACTOR_DOMAINS[id];
    }
  }
  return result;
}

/** Détection pure : teste un hostname contre un jeu de domaines fourni. */
export function detectExtractorIn(
  url: string,
  domains: Record<ExtractorId, string[]>,
): ExtractorId | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const id of EXTRACTOR_IDS) {
    if (domains[id].some(d => hostname.includes(d))) return id;
  }
  return null;
}
```

- [ ] **Step 4: Lancer les tests, vérifier le succès**

Run: `npm test`
Expected: PASS — 11 tests passent.

- [ ] **Step 5: Vérifier le build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/extractors/index.ts src/extractors/index.test.ts
git commit -m "feat(extractors): données de domaines + fusion + détection pure"
```

---

## Task 3: `detectExtractor` dynamique + chargement JSON + hot-reload

Bascule : `detectExtractor` lit désormais un jeu de domaines chargé depuis le
JSON ; suppression des anciennes constantes.

**Files:**
- Modify: `src/extractors/index.ts`
- Modify: `src/extractors/index.test.ts`

- [ ] **Step 1: Ajouter les tests de chargement**

Dans `src/extractors/index.test.ts`, **remplacer** la ligne d'import du haut
par ce bloc d'imports :

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  DEFAULT_EXTRACTOR_DOMAINS,
  EXTRACTOR_IDS,
  mergeExtractorDomains,
  detectExtractorIn,
  loadExtractorDomains,
  getExtractorDomains,
  detectExtractor,
} from './index';
```

Puis **ajouter** ces tests à la fin du fichier :

```typescript

function writeFixture(content: string): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'exd-'));
  const file = nodePath.join(dir, 'extractor-domains.json');
  fs.writeFileSync(file, content);
  return file;
}

test('loadExtractorDomains: lit un fichier valide', () => {
  const file = writeFixture(JSON.stringify({ voe: ['fixture-voe.test'] }));
  loadExtractorDomains(file);
  assert.deepEqual(getExtractorDomains().voe, ['fixture-voe.test']);
  assert.deepEqual(getExtractorDomains().uqload, DEFAULT_EXTRACTOR_DOMAINS.uqload);
});

test('loadExtractorDomains: JSON malformé retombe sur les défauts', () => {
  const file = writeFixture('{ ceci n est pas du json');
  loadExtractorDomains(file);
  assert.deepEqual(getExtractorDomains(), DEFAULT_EXTRACTOR_DOMAINS);
});

test('loadExtractorDomains: fichier absent retombe sur les défauts', () => {
  loadExtractorDomains('/chemin/inexistant/extractor-domains.json');
  assert.deepEqual(getExtractorDomains(), DEFAULT_EXTRACTOR_DOMAINS);
});

test('detectExtractor: utilise le jeu de domaines chargé', () => {
  const file = writeFixture(JSON.stringify({
    ...DEFAULT_EXTRACTOR_DOMAINS,
    voe: [...DEFAULT_EXTRACTOR_DOMAINS.voe, 'kathyinformationwhether.com'],
  }));
  loadExtractorDomains(file);
  assert.equal(detectExtractor('https://kathyinformationwhether.com/e/x'), 'voe');
});
```

- [ ] **Step 2: Lancer les tests, vérifier l'échec**

Run: `npm test`
Expected: FAIL — `loadExtractorDomains` / `getExtractorDomains` non exportés.

- [ ] **Step 3: Ajouter les imports `fs` / `path`**

En haut de `src/extractors/index.ts`, juste après `import axios from 'axios';`, ajouter :

```typescript
import * as fs from 'fs';
import * as path from 'path';
```

- [ ] **Step 4: Ajouter le chargement, le watch et les exports reload**

Dans `src/extractors/index.ts`, juste après la fonction `detectExtractorIn`
ajoutée en Task 2, insérer :

```typescript

const EXTRACTOR_DOMAINS_PATH = process.env.EXTRACTOR_DOMAINS_CONFIG ||
  (fs.existsSync('/app/config/extractor-domains.json')
    ? '/app/config/extractor-domains.json'
    : path.join(process.cwd(), 'config', 'extractor-domains.json'));

let currentDomains: Record<ExtractorId, string[]> = { ...DEFAULT_EXTRACTOR_DOMAINS };

/** Charge les domaines depuis le JSON (fallback défauts). Met à jour l'état module. */
export function loadExtractorDomains(
  filePath: string = EXTRACTOR_DOMAINS_PATH,
): Record<ExtractorId, string[]> {
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      currentDomains = mergeExtractorDomains(raw);
      console.log(`[ExtractorDomains] Loaded from ${filePath}`);
      return currentDomains;
    }
    console.log(`[ExtractorDomains] File not found, using defaults: ${filePath}`);
  } catch (e: any) {
    console.error(`[ExtractorDomains] Error loading, using defaults: ${e.message}`);
  }
  currentDomains = mergeExtractorDomains(null);
  return currentDomains;
}

export function getExtractorDomains(): Record<ExtractorId, string[]> {
  return currentDomains;
}

export function reloadExtractorDomains(): Record<ExtractorId, string[]> {
  return loadExtractorDomains();
}

loadExtractorDomains();

try {
  if (fs.existsSync(EXTRACTOR_DOMAINS_PATH)) {
    fs.watch(EXTRACTOR_DOMAINS_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[ExtractorDomains] File changed, reloading...');
        setTimeout(() => loadExtractorDomains(), 100);
      }
    });
  }
} catch {
  // fs.watch non supporté — le reload reste possible via l'endpoint
}
```

- [ ] **Step 5: Remplacer l'ancien `detectExtractor` par la version dynamique**

Dans `src/extractors/index.ts`, **supprimer** l'ancienne fonction
`export function detectExtractor(url: string): ExtractorId | null { ... }`
(et son commentaire `/** Detect which extractor... */`), et la remplacer par :

```typescript
/**
 * Detect which extractor to use based on URL, against the live domain set.
 * Returns an ID accepted both by our local fallback and MediaFlow.
 */
export function detectExtractor(url: string): ExtractorId | null {
  return detectExtractorIn(url, currentDomains);
}
```

- [ ] **Step 6: Supprimer les anciennes constantes de domaines**

Dans `src/extractors/index.ts`, **supprimer** les douze déclarations
`const *_DOMAINS = [...]` (`VOE_DOMAINS`, `DOOD_DOMAINS`, `FILEMOON_DOMAINS`,
`VIDOZA_DOMAINS`, `VIDMOLY_DOMAINS`, `STREAMTAPE_DOMAINS`, `MIXDROP_DOMAINS`,
`SHARECLOUDY_DOMAINS`, `LULUSTREAM_DOMAINS`, `FILELIONS_DOMAINS`,
`STREAMWISH_DOMAINS`) et leur commentaire `// Voe domains (they rotate frequently)`.
**Conserver** la ligne `type ExtractorId = ...`.

- [ ] **Step 7: Lancer les tests, vérifier le succès**

Run: `npm test`
Expected: PASS — 15 tests passent.

- [ ] **Step 8: Vérifier le build**

Run: `npm run build`
Expected: exit 0. Si `tsc` signale `VOE_DOMAINS is not defined` ou similaire,
c'est qu'une constante est encore référencée — la supprimer.

- [ ] **Step 9: Commit**

```bash
git add src/extractors/index.ts src/extractors/index.test.ts
git commit -m "feat(extractors): detectExtractor dynamique + chargement JSON hot-reload"
```

---

## Task 4: Fichier de config `extractor-domains.json`

**Files:**
- Create: `config/extractor-domains.json`

- [ ] **Step 1: Créer le fichier**

Créer `config/extractor-domains.json` avec exactement ce contenu :

```json
{
  "_comment": "Domaines reconnus par detectExtractor. Édité par le bot Telegram, hot-reloadé. Voir docs/superpowers/specs/2026-05-22-rotated-extractor-domains-design.md",
  "voe": ["voe", "voe.sx", "vidara.so", "vidara.to", "smoki.cc", "kinoger.ru", "ralphysuccessfull", "audaciousdefaulthouse", "launchreliantcleaverriver", "reputationsheriffkennethsand", "greaseball6eventual20", "timberwoodanotia", "yodelswartlike", "figeterpiazine", "chromotypic", "wolfdyslectic", "charlestoughrace"],
  "uqload": ["uqload"],
  "doodstream": ["dood", "doodstream", "dsvplay", "d0o0d", "dooood", "d0000d", "ds2play", "dood.re"],
  "filemoon": ["filemoon", "filmoon", "moonlink", "bysebuho", "moonplayer"],
  "vidoza": ["vidoza"],
  "vidmoly": ["vidmoly", "molystream", "vidhide"],
  "streamtape": ["streamtape", "strcloud", "shavetape", "tapewithadblock"],
  "mixdrop": ["mixdrop", "mdrop", "mdy48tn97"],
  "sharecloudy": ["sharecloudy", "moovbob", "moovtop"],
  "lulustream": ["luluvdo", "lulustream", "lulu.st"],
  "filelions": ["filelions", "minochinos", "javplaya", "lionshare"],
  "streamwish": ["streamwish", "hgcloud", "awish", "embedwish", "strwish"],
  "lastUpdatedAt": "2026-05-22T00:00:00.000Z"
}
```

- [ ] **Step 2: Vérifier que loostream charge bien ce fichier**

Run: `npm test`
Expected: PASS — les 15 tests passent toujours (les tests utilisent des
fixtures temporaires, indépendants de ce fichier).

- [ ] **Step 3: Commit**

```bash
git add config/extractor-domains.json
git commit -m "feat(config): fichier source extractor-domains.json"
```

---

## Task 5: Endpoint `/api/extractor-domains`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Étendre l'import depuis `./extractors`**

Dans `src/index.ts`, remplacer la ligne :

```typescript
import { ExtractorConfig } from './extractors';
```

par :

```typescript
import { ExtractorConfig, reloadExtractorDomains, getExtractorDomains } from './extractors';
```

- [ ] **Step 2: Ajouter la route**

Dans `src/index.ts`, juste après le bloc de l'endpoint
`app.get('/api/flemmix/endpoints', ...)`, ajouter :

```typescript

// Extractor domains admin (read + reload)
app.get('/api/extractor-domains', (req, res) => {
  const reload = req.query.reload === 'true';
  const current = reload ? reloadExtractorDomains() : getExtractorDomains();
  res.json({ ...current, reloaded: reload });
});
```

- [ ] **Step 3: Vérifier le build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(api): endpoint GET /api/extractor-domains?reload=true"
```

---

## Task 6: `flemmix.ts` — logguer les hôtes non reconnus

**Files:**
- Modify: `src/scrapers/flemmix.ts`

- [ ] **Step 1: Ajouter le log des embeds rejetés**

Dans `src/scrapers/flemmix.ts`, fonction `fetchFlemmixStreams`, juste **après**
la ligne :

```typescript
    console.log(`[Flemmix] ${embeds.length} embeds, ${supported.length} supported: ${supported.map(e => e.server).join(', ')}`);
```

insérer :

```typescript

    // Embeds rejetés : signale chaque hôte non reconnu (le bot Telegram grep ça).
    for (const e of embeds.filter(e => !supported.includes(e))) {
      let host = e.url;
      try { host = new URL(e.url).hostname; } catch { /* garde l'URL brute */ }
      console.log(`[Flemmix] Unrecognized host: ${host} (server="${e.server}", title="${frTitle}")`);
    }
```

- [ ] **Step 2: Vérifier le build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/scrapers/flemmix.ts
git commit -m "feat(flemmix): log des hôtes d'embed non reconnus"
```

---

## Task 7: `movix.ts` — logguer les hôtes non reconnus

**Files:**
- Modify: `src/scrapers/movix.ts`

- [ ] **Step 1: Capturer la liste d'embeds avant filtrage et logguer les rejetés**

Dans `src/scrapers/movix.ts`, fonction `fetchMovixStreams`, **remplacer** :

```typescript
  // Merge embed links, keep only those our extractor supports (Voe/Uqload)
  const allEmbeds = [...cpasmalLinks, ...fstreamLinks].filter(link => {
    try { return detectExtractor(link.url) !== null; } catch { return false; }
  });
```

par :

```typescript
  // Merge embed links, keep only those our extractor supports.
  const combinedEmbeds = [...cpasmalLinks, ...fstreamLinks];
  const allEmbeds = combinedEmbeds.filter(link => {
    try { return detectExtractor(link.url) !== null; } catch { return false; }
  });

  // Embeds rejetés : signale chaque hôte non reconnu (le bot Telegram grep ça).
  // movix ne résout pas de titre humain ici => title vide.
  for (const link of combinedEmbeds.filter(l => !allEmbeds.includes(l))) {
    let host = link.url;
    try { host = new URL(link.url).hostname; } catch { /* garde l'URL brute */ }
    console.log(`[Movix] Unrecognized host: ${host} (server="${link.server}", title="")`);
  }
```

- [ ] **Step 2: Vérifier le build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/scrapers/movix.ts
git commit -m "feat(movix): log des hôtes d'embed non reconnus"
```

---

## Task 8: Helpers purs du bot

**Files:**
- Create: `telegram-bot-domains.js`
- Create: `telegram-bot-domains.test.js`

- [ ] **Step 1: Écrire les tests**

Créer `telegram-bot-domains.test.js` :

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  deduceExtractor,
  parseUnrecognizedHostLine,
  addDomainToExtractorConfig,
} = require('./telegram-bot-domains');

test('deduceExtractor: mappe les labels connus', () => {
  assert.equal(deduceExtractor('Voe'), 'voe');
  assert.equal(deduceExtractor('Vidara'), 'voe');
  assert.equal(deduceExtractor('LuLuTV'), 'lulustream');
  assert.equal(deduceExtractor('DdStream'), 'doodstream');
  assert.equal(deduceExtractor('Swish'), 'streamwish');
  assert.equal(deduceExtractor('uqload'), 'uqload');
  assert.equal(deduceExtractor('Vmoly'), 'vidmoly');
});

test('deduceExtractor: label inconnu ou générique renvoie null', () => {
  assert.equal(deduceExtractor('vostfr 1'), null);
  assert.equal(deduceExtractor('Hxfile'), null);
  assert.equal(deduceExtractor('Vidsonic'), null);
  assert.equal(deduceExtractor(''), null);
  assert.equal(deduceExtractor(undefined), null);
});

test('parseUnrecognizedHostLine: parse une ligne flemmix', () => {
  const line = '[Flemmix] Unrecognized host: kathyinformationwhether.com (server="Voe", title="Projet Dernière Chance")';
  assert.deepEqual(parseUnrecognizedHostLine(line), {
    scraper: 'Flemmix',
    host: 'kathyinformationwhether.com',
    server: 'Voe',
    title: 'Projet Dernière Chance',
  });
});

test('parseUnrecognizedHostLine: parse une ligne movix au titre vide', () => {
  const line = '[Movix] Unrecognized host: playmogo.com (server="DdStream", title="")';
  assert.deepEqual(parseUnrecognizedHostLine(line), {
    scraper: 'Movix', host: 'playmogo.com', server: 'DdStream', title: '',
  });
});

test('parseUnrecognizedHostLine: ligne non concernée renvoie null', () => {
  assert.equal(parseUnrecognizedHostLine('[Flemmix] 15 embeds, 6 supported: Voe'), null);
});

test('addDomainToExtractorConfig: ajoute un nouveau domaine', () => {
  const { config, added } = addDomainToExtractorConfig({ voe: ['a.test'] }, 'voe', 'b.test');
  assert.equal(added, true);
  assert.deepEqual(config.voe, ['a.test', 'b.test']);
});

test('addDomainToExtractorConfig: domaine en double non ajouté', () => {
  const { config, added } = addDomainToExtractorConfig({ voe: ['a.test'] }, 'voe', 'a.test');
  assert.equal(added, false);
  assert.deepEqual(config.voe, ['a.test']);
});

test('addDomainToExtractorConfig: crée le tableau de l\'extracteur si absent', () => {
  const { config, added } = addDomainToExtractorConfig({}, 'voe', 'a.test');
  assert.equal(added, true);
  assert.deepEqual(config.voe, ['a.test']);
});
```

- [ ] **Step 2: Lancer les tests, vérifier l'échec**

Run: `npm test`
Expected: FAIL — `Cannot find module './telegram-bot-domains'`.

- [ ] **Step 3: Implémenter les helpers**

Créer `telegram-bot-domains.js` :

```javascript
// Helpers purs pour l'ajout assisté de domaines d'extracteurs. Aucun effet de bord.

// Tokens de label (minuscules) -> extracteur. Premier match gagne.
const LABEL_TO_EXTRACTOR = [
  { tokens: ['vidara', 'voe'], extractor: 'voe' },
  { tokens: ['uqload'], extractor: 'uqload' },
  { tokens: ['vmoly', 'vidmoly', 'molystream', 'vidhide'], extractor: 'vidmoly' },
  { tokens: ['filelions', 'lions'], extractor: 'filelions' },
  { tokens: ['swish', 'streamwish', 'wish'], extractor: 'streamwish' },
  { tokens: ['lulu'], extractor: 'lulustream' },
  { tokens: ['dood', 'ddstream'], extractor: 'doodstream' },
  { tokens: ['vidoza'], extractor: 'vidoza' },
  { tokens: ['filemoon', 'moon'], extractor: 'filemoon' },
  { tokens: ['streamtape', 'tape'], extractor: 'streamtape' },
  { tokens: ['mixdrop', 'mdrop'], extractor: 'mixdrop' },
  { tokens: ['sharecloudy', 'cloudy'], extractor: 'sharecloudy' },
];

/** Déduit l'extracteur depuis un label serveur. null si inconnu/générique. */
function deduceExtractor(label) {
  if (!label || typeof label !== 'string') return null;
  const norm = label.toLowerCase();
  for (const entry of LABEL_TO_EXTRACTOR) {
    if (entry.tokens.some(t => norm.includes(t))) return entry.extractor;
  }
  return null;
}

const LOG_RE = /\[(Flemmix|Movix)\] Unrecognized host: (\S+) \(server="([^"]*)", title="([^"]*)"\)/;

/** Parse une ligne de log "Unrecognized host". null si non concernée. */
function parseUnrecognizedHostLine(line) {
  const m = line.match(LOG_RE);
  if (!m) return null;
  return { scraper: m[1], host: m[2], server: m[3], title: m[4] };
}

/**
 * Ajoute un domaine au tableau d'un extracteur dans un objet de config.
 * Renvoie { config: <nouvel objet>, added: boolean }. Ne mute pas l'entrée.
 */
function addDomainToExtractorConfig(config, extractor, domain) {
  const next = (config && typeof config === 'object') ? { ...config } : {};
  const list = Array.isArray(next[extractor]) ? next[extractor].slice() : [];
  if (list.includes(domain)) {
    return { config: next, added: false };
  }
  list.push(domain);
  next[extractor] = list;
  next.lastUpdatedAt = new Date().toISOString();
  return { config: next, added: true };
}

module.exports = { deduceExtractor, parseUnrecognizedHostLine, addDomainToExtractorConfig };
```

- [ ] **Step 4: Lancer les tests, vérifier le succès**

Run: `npm test`
Expected: PASS — tous les tests (15 TS + 8 JS) passent.

- [ ] **Step 5: Commit**

```bash
git add telegram-bot-domains.js telegram-bot-domains.test.js
git commit -m "feat(bot): helpers purs déduction/parsing/mutation config"
```

---

## Task 9: Câblage du bot Telegram

Câblage I/O (pas de test unitaire — la logique pure est couverte en Task 8).
Vérification : contrôle de syntaxe + checklist manuelle en Task 11.

**Files:**
- Modify: `telegram-bot.js`

- [ ] **Step 1: Importer les helpers et déclarer le chemin de config**

En haut de `telegram-bot.js`, après le bloc des `require(...)`, ajouter :

```javascript
const {
  deduceExtractor,
  parseUnrecognizedHostLine,
  addDomainToExtractorConfig,
} = require('./telegram-bot-domains');
const EXTRACTOR_DOMAINS_PATH = process.env.EXTRACTOR_DOMAINS_CONFIG || './config/extractor-domains.json';
```

- [ ] **Step 2: Ajouter les fonctions de traitement et d'alerte**

Dans `telegram-bot.js`, ajouter ces fonctions (par ex. juste avant
`function monitorLogs()`) :

```javascript
// --- Domaines d'extracteurs rotés ---

function triggerExtractorDomainsReload() {
  const req = http.get('http://loostream:7002/api/extractor-domains?reload=true', (res) => {
    res.resume();
    console.log(`[ExtractorDomains] Reload déclenché (HTTP ${res.statusCode})`);
  });
  req.on('error', (e) => console.error('[ExtractorDomains] Reload échoué:', e.message));
  req.setTimeout(5000, () => req.destroy());
}

function addExtractorDomain(extractor, domain) {
  let raw = {};
  try {
    if (fs.existsSync(EXTRACTOR_DOMAINS_PATH)) {
      raw = JSON.parse(fs.readFileSync(EXTRACTOR_DOMAINS_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[ExtractorDomains] Lecture/parse échoué, abandon:', e.message);
    return false;
  }
  const { config, added } = addDomainToExtractorConfig(raw, extractor, domain);
  if (added) {
    fs.writeFileSync(EXTRACTOR_DOMAINS_PATH, JSON.stringify(config, null, 2));
    console.log(`[ExtractorDomains] ${domain} ajouté à ${extractor}`);
    triggerExtractorDomainsReload();
  }
  return added;
}

function handleUnrecognizedHost(info) {
  const alertKey = `xdom:${info.host}`;
  if (sentAlerts.has(alertKey)) return;
  const extractor = deduceExtractor(info.server);
  if (!extractor) return; // label inconnu/générique => silencieux
  sentAlerts.add(alertKey);
  setTimeout(() => sentAlerts.delete(alertKey), ALERT_COOLDOWN);
  sendExtractorDomainAlert(info.host, info.server, info.title, extractor);
}

async function sendExtractorDomainAlert(host, server, title, extractor) {
  let message = `⚠️ <b>Domaine d'extracteur inconnu</b>\n\n` +
    `<code>${host}</code>\n` +
    `serveur : « ${server} »`;
  if (title) message += `  —  film : ${title}`;
  const buttons = [
    [{ text: `➕ Ajouter à ${extractor}`, callback_data: `xadd:${extractor}:${host}` }],
    [{ text: '❌ Ignorer', callback_data: `xign:${host}` }],
  ];
  try {
    await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
    console.log(`[ExtractorDomains] Alerte envoyée: ${host} -> ${extractor}`);
  } catch (e) {
    console.error('[ExtractorDomains] Envoi alerte échoué:', e.message);
  }
}
```

> `CHAT_ID` (déclaré ≈ ligne 91) et `ALERT_COOLDOWN` (≈ ligne 95) existent
> déjà dans `telegram-bot.js` et sont utilisés tels quels ci-dessus.

- [ ] **Step 3: Brancher le parsing dans `monitorLogs()`**

Dans `telegram-bot.js`, fonction `monitorLogs()`, il y a deux boucles
identiques (sur `docker.stdout` et `docker.stderr`) qui font
`const match = line.match(/Domain not whitelisted: .../)`. Dans **chacune des
deux boucles**, juste après le bloc `if (match) { ... }`, ajouter :

```javascript
      const unrec = parseUnrecognizedHostLine(line);
      if (unrec) {
        handleUnrecognizedHost(unrec);
      }
```

- [ ] **Step 4: Gérer les nouveaux callbacks**

Dans `telegram-bot.js`, fonction `handleCallbackQuery(query)` : la fonction
commence par `const { id, data, message } = query;` puis fait
`const [action, domain] = data.split(':')` et branche sur `action`. **Ajouter,
juste après la ligne `const { id, data, message } = query;` et avant le
`data.split(':')`**, la gestion des actions `xadd` et `xign` :

```javascript
  // Domaines d'extracteurs rotés
  if (data.startsWith('xadd:')) {
    const rest = data.slice(5);
    const sep = rest.indexOf(':');
    const extractor = rest.slice(0, sep);
    const xdomain = rest.slice(sep + 1);
    const ok = addExtractorDomain(extractor, xdomain);
    await telegramRequest('answerCallbackQuery', {
      callback_query_id: id,
      text: ok
        ? `✅ ${xdomain} ajouté à ${extractor}`
        : `ℹ️ ${xdomain} déjà présent`,
    });
    await telegramRequest('editMessageText', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: ok
        ? `✅ <code>${xdomain}</code> ajouté à <b>${extractor}</b> (rechargé)`
        : `ℹ️ <code>${xdomain}</code> était déjà dans <b>${extractor}</b>`,
      parse_mode: 'HTML',
    });
    return;
  }
  if (data.startsWith('xign:')) {
    const xdomain = data.slice(5);
    await telegramRequest('answerCallbackQuery', {
      callback_query_id: id,
      text: `🔇 ${xdomain} ignoré`,
    });
    await telegramRequest('editMessageText', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `🔇 <code>${xdomain}</code> ignoré`,
      parse_mode: 'HTML',
    });
    return;
  }
```

- [ ] **Step 5: Contrôle de syntaxe**

Run: `node --check telegram-bot.js && node --check telegram-bot-domains.js`
Expected: exit 0, aucune sortie.

- [ ] **Step 6: Commit**

```bash
git add telegram-bot.js
git commit -m "feat(bot): détection domaines rotés, alerte et ajout d'un clic"
```

---

## Task 10: `Dockerfile.telegram` — embarquer le helper

**Files:**
- Modify: `Dockerfile.telegram`

- [ ] **Step 1: Copier le nouveau fichier dans l'image du bot**

Dans `Dockerfile.telegram`, remplacer la ligne :

```dockerfile
COPY telegram-bot.js .
```

par :

```dockerfile
COPY telegram-bot.js telegram-bot-domains.js ./
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile.telegram
git commit -m "build(bot): embarque telegram-bot-domains.js dans l'image"
```

---

## Task 11: Vérification intégrée & déploiement

**Files:** aucun (build, déploiement, vérification manuelle)

- [ ] **Step 1: Suite complète**

Run: `npm test`
Expected: PASS — 15 tests TS + 8 tests JS, exit 0.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Déployer addon + bot**

Run: `docker compose --profile telegram up -d --build`
Expected: conteneurs `loostream` et `loostream-telegram` recréés et démarrés.

- [ ] **Step 4: Vérifier le chargement au boot**

Run: `docker logs loostream --since 60s 2>&1 | grep ExtractorDomains`
Expected: `[ExtractorDomains] Loaded from /app/config/extractor-domains.json`.

- [ ] **Step 5: Vérifier l'endpoint de reload**

Run: `curl -s "http://127.0.0.1:7002/api/extractor-domains?reload=true"`
Expected: JSON contenant les 12 clés d'extracteurs et `"reloaded":true`.

- [ ] **Step 6: Vérifier la détection (log scraper)**

Lancer une lecture/recherche réelle dans Stremio sur un film dont une source
est sur un domaine roté, puis :
Run: `docker logs loostream --since 3m 2>&1 | grep "Unrecognized host"`
Expected: au moins une ligne
`[Flemmix] Unrecognized host: <host> (server="<label>", title="<titre>")`.

- [ ] **Step 7: Vérifier le hot-reload manuel**

Éditer `config/extractor-domains.json` (ajouter un domaine bidon à `voe`),
sauvegarder, puis :
Run: `docker logs loostream --since 30s 2>&1 | grep ExtractorDomains`
Expected: `[ExtractorDomains] File changed, reloading...` puis `Loaded from ...`.
Retirer ensuite le domaine bidon.

- [ ] **Step 8: Vérifier le bot (de bout en bout)**

Quand le bot envoie une alerte « ⚠️ Domaine d'extracteur inconnu », cliquer
« ➕ Ajouter à … ». Vérifier : le message Telegram passe à
« ✅ … ajouté … (rechargé) », le domaine apparaît dans
`config/extractor-domains.json`, et `docker logs loostream` montre le reload.

- [ ] **Step 9: Commit final si nécessaire**

Si le hot-reload manuel (Step 7) a laissé le fichier modifié, le restaurer :
```bash
git checkout config/extractor-domains.json
```
Aucun commit attendu à cette étape si les Steps 7/8 ont été nettoyés.

---

## Notes de revue (auto-revue de l'auteur)

- **Couverture spec** : §5 modèle JSON → Task 4 ; §6.1 extractors → Tasks 2-3 ;
  §6.2 logs scrapers → Tasks 6-7 ; §6.3 endpoint → Task 5 ; §7 bot → Tasks 8-9 ;
  §8 cas limites → couverts par les tests (fallback, doublon, label inconnu) et
  la dédup `sentAlerts` ; §9 tests → Tasks 2,3,8 ; §10 déploiement → Tasks 10-11.
- **Cohérence des types** : `mergeExtractorDomains`, `detectExtractorIn`,
  `loadExtractorDomains`, `getExtractorDomains`, `reloadExtractorDomains`,
  `detectExtractor`, `EXTRACTOR_IDS`, `DEFAULT_EXTRACTOR_DOMAINS` — noms
  identiques entre définition (Tasks 2-3), import `src/index.ts` (Task 5) et
  tests. Helpers bot `deduceExtractor` / `parseUnrecognizedHostLine` /
  `addDomainToExtractorConfig` — identiques entre Task 8 et Task 9.
- **Format de log** unique : `[Flemmix|Movix] Unrecognized host: <host> (server="<label>", title="<titre>")`
  — émis identiquement en Tasks 6-7, parsé par le même regex en Task 8.

# Espace admin multi-pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer l'admin single-page par un espace multi-vues (Dashboard, Stats, Logs, Paramétrage) avec logs live et réglages runtime éditables.

**Architecture:** Deux nouveaux modules backend — `src/logbuffer.ts` (ring mémoire capturant `console.*`, secrets masqués) et `src/settings.ts` (réglages runtime surchargeant le `.env`, hot-reload via fichier). Trois getters existants (`allowedModes`, `ownerKey`, `AUTO_WHITELIST`) lisent désormais ces réglages. Nouveaux endpoints `/api/logs`, `/api/settings`. `src/admin.html` réécrit en SPA sidebar (aucun build front — servi tel quel).

**Tech Stack:** TypeScript strict (tsc), Express hand-rolled, node:test (+ tsx) pour les tests unitaires, HTML/CSS/JS vanilla autonome.

## Global Constraints

- Messages de commit en **français**, style conventionnel, terminés par `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Ne jamais** renvoyer OWNER_KEY/ACCESS_KEY en clair par une API ; le buffer de logs **masque** ces secrets.
- Précédence des réglages : `config/runtime-settings.json` (clé présente) > `.env` > défaut codé.
- `tsc --strict` est le seul check statique (via `npm run build`) ; pas de `any` gratuit.
- Rebuild conteneur = `npm run build` local PUIS `docker compose up -d --build loostream` (le Dockerfile copie `dist/`).
- Toutes les routes admin en écriture derrière `requireAdminSession`.

---

### Task 1: Buffer de logs mémoire — `src/logbuffer.ts`

**Files:**
- Create: `src/logbuffer.ts`
- Test: `src/logbuffer.test.ts`

**Interfaces:**
- Produces:
  - `interface LogLine { seq: number; ts: number; level: 'info'|'warn'|'error'; source: string; msg: string }`
  - `function maskSecrets(s: string): string` — remplace les valeurs de OWNER_KEY/ACCESS_KEY et les `k=`/`api_password=` par `***`.
  - `function pushLog(level: 'info'|'warn'|'error', text: string): void` — dérive source+masque+range.
  - `function getLogs(opts: { sinceSeq?: number; source?: string; level?: string; q?: string; limit?: number }): { lines: LogLine[]; lastSeq: number; sources: string[] }`
  - `function installLogCapture(): void` — wrap `console.log/warn/error` (idempotent).

- [ ] **Step 1: Write the failing test** (`src/logbuffer.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { pushLog, getLogs, maskSecrets } from './logbuffer';

test('maskSecrets masque une clé en query et un api_password', () => {
  process.env.ACCESS_KEY = 'topsecret123';
  assert.ok(!maskSecrets('proxy?k=topsecret123&x=1').includes('topsecret123'));
  assert.ok(!maskSecrets('url?api_password=abcdef').includes('abcdef'));
  delete process.env.ACCESS_KEY;
});

test('pushLog dérive la source depuis le tag [Xxx] et le niveau', () => {
  pushLog('info', '[Videasy] 2 flux trouvés');
  const { lines } = getLogs({ limit: 1 });
  assert.equal(lines[0].source, 'Videasy');
  assert.equal(lines[0].level, 'info');
});

test('getLogs filtre par source, niveau, texte et sinceSeq', () => {
  const before = getLogs({}).lastSeq;
  pushLog('error', '[Movix] échec extraction xyz');
  pushLog('info', '[Coflix] ok');
  const errs = getLogs({ level: 'error', sinceSeq: before });
  assert.ok(errs.lines.every(l => l.level === 'error'));
  const movix = getLogs({ source: 'Movix', sinceSeq: before });
  assert.ok(movix.lines.every(l => l.source === 'Movix'));
  const q = getLogs({ q: 'xyz', sinceSeq: before });
  assert.ok(q.lines.length >= 1 && q.lines.every(l => l.msg.includes('xyz')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="maskSecrets|pushLog|getLogs"` (ou `node --import tsx --test src/logbuffer.test.ts`)
Expected: FAIL — `Cannot find module './logbuffer'`.

- [ ] **Step 3: Write minimal implementation** (`src/logbuffer.ts`)

```ts
// Buffer de logs en mémoire pour l'admin (page Logs). On intercepte console.*,
// on range { seq, ts, level, source, msg } dans un ring borné, PUIS on délègue à
// l'original (les logs Docker restent intacts). Les secrets sont masqués avant
// stockage — ce buffer est lisible via /api/logs (derrière la session admin),
// il ne doit jamais contenir OWNER_KEY/ACCESS_KEY en clair.

export interface LogLine {
  seq: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  msg: string;
}

const MAX = 1000;
const ring: LogLine[] = [];
let seq = 0;

/** Masque les secrets connus dans une ligne de log. */
export function maskSecrets(s: string): string {
  let out = s;
  for (const v of [process.env.OWNER_KEY, process.env.ACCESS_KEY, process.env.MEDIAFLOW_PASSWORD]) {
    if (v && v.length >= 4) out = out.split(v).join('***');
  }
  // Valeurs de query sensibles, même si la clé n'est pas dans l'env (défense).
  out = out.replace(/([?&](?:k|api_password|password)=)[^&\s]+/gi, '$1***');
  return out;
}

// Niveau déduit du texte pour les lignes venant de console.log (qui sert de
// fourre-tout). Les marqueurs d'erreur/alerte des scrapers priment.
function deriveLevel(fallback: 'info' | 'warn' | 'error', text: string): 'info' | 'warn' | 'error' {
  if (fallback === 'error') return 'error';
  if (/\b(error|échec|failed|KO)\b|❌/i.test(text)) return 'error';
  if (/⚠|\bwarn(ing)?\b|not whitelisted/i.test(text)) return 'warn';
  return fallback;
}

// Source = tag [Xxx] en tête de ligne, sinon 'system'.
function deriveSource(text: string): string {
  const m = text.match(/^\s*\[([A-Za-z0-9 _-]{1,24})\]/);
  return m ? m[1].trim() : 'system';
}

export function pushLog(level: 'info' | 'warn' | 'error', text: string): void {
  const masked = maskSecrets(text);
  ring.push({
    seq: ++seq,
    ts: Date.now(),
    level: deriveLevel(level, masked),
    source: deriveSource(masked),
    msg: masked.length > 2000 ? masked.slice(0, 2000) + '…' : masked,
  });
  if (ring.length > MAX) ring.shift();
}

export function getLogs(opts: {
  sinceSeq?: number; source?: string; level?: string; q?: string; limit?: number;
} = {}): { lines: LogLine[]; lastSeq: number; sources: string[] } {
  const sources = [...new Set(ring.map(l => l.source))].sort();
  const q = opts.q ? opts.q.toLowerCase() : '';
  let lines = ring.filter(l =>
    (opts.sinceSeq == null || l.seq > opts.sinceSeq) &&
    (!opts.source || l.source === opts.source) &&
    (!opts.level || l.level === opts.level) &&
    (!q || l.msg.toLowerCase().includes(q)),
  );
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), MAX);
  if (lines.length > limit) lines = lines.slice(lines.length - limit);
  return { lines, lastSeq: seq, sources };
}

let installed = false;
export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const wrap = (level: 'info' | 'warn' | 'error', fn: (...a: any[]) => void) =>
    (...args: any[]) => {
      try {
        pushLog(level, args.map(a => (typeof a === 'string' ? a : safeStr(a))).join(' '));
      } catch { /* ne jamais casser un console.* */ }
      fn(...args);
    };
  console.log = wrap('info', orig.log);
  console.warn = wrap('warn', orig.warn);
  console.error = wrap('error', orig.error);
}

function safeStr(a: unknown): string {
  try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
  catch { return String(a); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/logbuffer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/logbuffer.ts src/logbuffer.test.ts
git commit -m "feat(admin): buffer de logs mémoire (capture console.*, secrets masqués)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Câbler la capture au boot + endpoint `GET /api/logs`

**Files:**
- Modify: `src/index.ts` — import `logbuffer`, appeler `installLogCapture()` tout en haut du boot (avant les autres `console.log`), ajouter la route.

**Interfaces:**
- Consumes: `installLogCapture`, `getLogs` de `./logbuffer`.
- Produces: `GET /api/logs?sinceSeq=&source=&level=&q=&limit=` → `{ lines, lastSeq, sources }` (derrière `requireAdminSession`).

- [ ] **Step 1: Ajouter l'import et la capture au tout début** (après les imports, avant le 1er `console.log` de boot — juste après la création de `app` en haut de fichier)

```ts
import { installLogCapture, getLogs } from './logbuffer';
// ... (après les imports, le plus tôt possible dans l'exécution du module) :
installLogCapture();
```

- [ ] **Step 2: Ajouter la route près des autres `/api/*`** (ex. juste après `/api/cache/stats`, ligne ~1806)

```ts
// Logs live pour l'admin — lit le ring mémoire (secrets déjà masqués à l'écriture).
app.get('/api/logs', requireAdminSession, (req, res) => {
  const num = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : undefined);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  res.json(getLogs({
    sinceSeq: num(req.query.sinceSeq),
    source: str(req.query.source),
    level: str(req.query.level),
    q: str(req.query.q),
    limit: num(req.query.limit),
  }));
});
```

- [ ] **Step 3: Vérifier la compilation**

Run: `npm run build`
Expected: `tsc` sans erreur ; `dist/logbuffer.js` présent.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(admin): capture des logs au boot + endpoint GET /api/logs (admin)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Réglages runtime — `src/settings.ts`

**Files:**
- Create: `src/settings.ts`
- Create: `config/runtime-settings.json` (fichier vide `{}` + `_comment`)
- Test: `src/settings.test.ts`

**Interfaces:**
- Produces:
  - `function getModeRaw(): string` — la chaîne MODE effective (fichier sinon `process.env.MODE` sinon `''`).
  - `function getOwnerKeyValue(): string | undefined` — clé effective (fichier sinon env ; `''`/absent → undefined).
  - `function autoWhitelistEnabled(): boolean` — bool effectif (fichier sinon `process.env.AUTO_WHITELIST === 'true'`).
  - `function updateSettings(patch: { mode?: string|null; ownerKey?: string|null; autoWhitelist?: boolean|null }): void` — merge, écrit le fichier, invalide le cache. `null` = revenir au fallback env (retire la clé du fichier).
  - `function settingsView(): { mode: string; modeSource: 'file'|'env'|'default'; ownerKey: { configured: boolean; length: number; source: 'file'|'env'|'none' }; autoWhitelist: boolean; autoWhitelistSource: 'file'|'env' }`

**Interfaces (consommées par d'autres tasks):**
- Task 4 câble `getModeRaw` dans `allowedModes`, `getOwnerKeyValue` dans `access.ownerKey`, `autoWhitelistEnabled` dans `proxy`.

- [ ] **Step 1: Write the failing test** (`src/settings.test.ts`)

```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { getModeRaw, getOwnerKeyValue, autoWhitelistEnabled, updateSettings, settingsView } from './settings';

const p = path.join(process.cwd(), 'config', 'runtime-settings.json');
afterEach(() => { try { fs.writeFileSync(p, '{}'); } catch {} });

test('fallback env quand le fichier est vide', () => {
  fs.writeFileSync(p, '{}');
  process.env.MODE = 'DIRECT';
  process.env.AUTO_WHITELIST = 'true';
  assert.equal(getModeRaw(), 'DIRECT');
  assert.equal(autoWhitelistEnabled(), true);
});

test('le fichier surcharge l\'env', () => {
  process.env.MODE = 'DIRECT';
  updateSettings({ mode: 'DIRECT;LOCAL', autoWhitelist: false });
  assert.equal(getModeRaw(), 'DIRECT;LOCAL');
  assert.equal(autoWhitelistEnabled(), false);
});

test('null retire la surcharge (retour env)', () => {
  process.env.MODE = 'MFP';
  updateSettings({ mode: 'LOCAL' });
  assert.equal(getModeRaw(), 'LOCAL');
  updateSettings({ mode: null });
  assert.equal(getModeRaw(), 'MFP');
});

test('settingsView ne divulgue jamais la clé en clair', () => {
  updateSettings({ ownerKey: 'abcd1234efgh' });
  const v = settingsView();
  assert.equal(v.ownerKey.configured, true);
  assert.equal(v.ownerKey.length, 12);
  assert.ok(!JSON.stringify(v).includes('abcd1234efgh'));
  assert.equal(getOwnerKeyValue(), 'abcd1234efgh');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/settings.test.ts`
Expected: FAIL — `Cannot find module './settings'`.

- [ ] **Step 3: Write minimal implementation** (`src/settings.ts`)

```ts
import * as fs from 'fs';
import * as path from 'path';

// Réglages runtime éditables depuis l'admin (page Paramétrage > Partage).
// Surchargent le .env : une clé PRÉSENTE dans le fichier gagne ; absente → fallback
// env → défaut. Écrits dans config/runtime-settings.json (bind-mount docker → pas de
// rebuild). Lecture avec cache invalidé à l'écriture.

interface RuntimeSettings {
  mode?: string;
  ownerKey?: string;
  autoWhitelist?: boolean;
}

const filePath = process.env.RUNTIME_SETTINGS_CONFIG ||
  (fs.existsSync('/app/config/runtime-settings.json')
    ? '/app/config/runtime-settings.json'
    : path.join(process.cwd(), 'config', 'runtime-settings.json'));

let cache: RuntimeSettings | null = null;

function load(): RuntimeSettings {
  if (cache) return cache;
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      cache = {
        mode: typeof raw.mode === 'string' ? raw.mode : undefined,
        ownerKey: typeof raw.ownerKey === 'string' && raw.ownerKey ? raw.ownerKey : undefined,
        autoWhitelist: typeof raw.autoWhitelist === 'boolean' ? raw.autoWhitelist : undefined,
      };
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  return cache;
}

export function getModeRaw(): string {
  const s = load();
  return s.mode !== undefined ? s.mode : (process.env.MODE || '');
}

export function getOwnerKeyValue(): string | undefined {
  const s = load();
  if (s.ownerKey !== undefined) return s.ownerKey;
  const env = process.env.OWNER_KEY;
  return env && env.length > 0 ? env : undefined;
}

export function autoWhitelistEnabled(): boolean {
  const s = load();
  return s.autoWhitelist !== undefined ? s.autoWhitelist : (process.env.AUTO_WHITELIST === 'true');
}

export function updateSettings(patch: {
  mode?: string | null; ownerKey?: string | null; autoWhitelist?: boolean | null;
}): void {
  const current = { ...load() };
  const apply = <K extends keyof RuntimeSettings>(k: K, v: RuntimeSettings[K] | null | undefined) => {
    if (v === undefined) return;            // non fourni → inchangé
    if (v === null) delete current[k];      // null → retour au fallback env
    else current[k] = v;
  };
  apply('mode', patch.mode);
  apply('ownerKey', patch.ownerKey === null ? null : (patch.ownerKey || undefined));
  apply('autoWhitelist', patch.autoWhitelist);
  fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
  cache = null; // invalide
}

export function settingsView(): {
  mode: string; modeSource: 'file' | 'env' | 'default';
  ownerKey: { configured: boolean; length: number; source: 'file' | 'env' | 'none' };
  autoWhitelist: boolean; autoWhitelistSource: 'file' | 'env';
} {
  const s = load();
  const ownerFile = s.ownerKey !== undefined;
  const ownerEnv = !!(process.env.OWNER_KEY && process.env.OWNER_KEY.length > 0);
  const owner = getOwnerKeyValue();
  return {
    mode: getModeRaw(),
    modeSource: s.mode !== undefined ? 'file' : (process.env.MODE ? 'env' : 'default'),
    ownerKey: {
      configured: !!owner,
      length: owner ? owner.length : 0,
      source: ownerFile ? 'file' : (ownerEnv ? 'env' : 'none'),
    },
    autoWhitelist: autoWhitelistEnabled(),
    autoWhitelistSource: s.autoWhitelist !== undefined ? 'file' : 'env',
  };
}
```

- [ ] **Step 4: Créer `config/runtime-settings.json`**

```json
{
  "_comment": "Réglages runtime éditables depuis l'admin (Paramétrage > Partage). Surchargent le .env. Géré par l'app — édition manuelle possible mais l'admin réécrit ce fichier."
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test src/settings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/settings.ts src/settings.test.ts config/runtime-settings.json
git commit -m "feat(admin): réglages runtime (mode/ownerKey/autoWhitelist) surchargeant le .env

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Câbler les getters runtime + endpoints `/api/settings`

**Files:**
- Modify: `src/access.ts` — `ownerKey()` lit `getOwnerKeyValue()`.
- Modify: `src/proxy.ts` — remplacer `export const AUTO_WHITELIST` par la fonction `autoWhitelistEnabled()` aux points d'usage.
- Modify: `src/index.ts` — `allowedModes()` lit `getModeRaw()` ; remplacer les usages `AUTO_WHITELIST`/`process.env.AUTO_WHITELIST` ; ajouter `GET`/`POST /api/settings`.

**Interfaces:**
- Consumes: `getModeRaw`, `getOwnerKeyValue`, `autoWhitelistEnabled`, `updateSettings`, `settingsView` de `./settings`.
- Produces: `GET /api/settings` → `settingsView()` ; `POST /api/settings` (admin) → applique + renvoie `settingsView()`.

- [ ] **Step 1: `src/access.ts` — brancher ownerKey sur les settings**

Remplacer le corps de `ownerKey()` :

```ts
import { getOwnerKeyValue } from './settings';
// ...
export function ownerKey(): string | undefined {
  return getOwnerKeyValue();
}
```

- [ ] **Step 2: `src/proxy.ts` — AUTO_WHITELIST const → fonction**

Remplacer `export const AUTO_WHITELIST = process.env.AUTO_WHITELIST === 'true';` par un ré-export de la fonction, et l'usage dans `buildManifestUrl` :

```ts
import { autoWhitelistEnabled } from './settings';
export { autoWhitelistEnabled };
// dans buildManifestUrl :
const learn = autoWhitelistEnabled()
  ? (u: string) => { try { addAllowedDomain(new URL(u).hostname); } catch { /* url invalide */ } }
  : (_u: string) => { /* no-op */ };
```

- [ ] **Step 3: `src/index.ts` — allowedModes + usages AUTO_WHITELIST + whitelist status**

```ts
// import :
import { getModeRaw, autoWhitelistEnabled, updateSettings, settingsView } from './settings';
// remplacer AUTO_WHITELIST dans l'import depuis './proxy' (retirer AUTO_WHITELIST, garder le reste)

// allowedModes() :
function allowedModes(): ('direct' | 'mediaflow' | 'local')[] {
  const raw = getModeRaw().trim();
  // ... (reste inchangé)
}

// ligne ~516 (auto-whitelist à l'extraction) : if (AUTO_WHITELIST) -> if (autoWhitelistEnabled())
// ligne ~1675 (/api/whitelist) : autoWhitelist: autoWhitelistEnabled()
```

- [ ] **Step 4: `src/index.ts` — endpoints `/api/settings`** (près de `/api/whitelist`)

```ts
// Réglages runtime (Paramétrage > Partage). GET public (lecture non sensible :
// aucune clé en clair) ; POST derrière la session admin.
app.get('/api/settings', (_req, res) => {
  res.json(settingsView());
});
app.post('/api/settings', requireAdminSession, jsonBody, (req, res) => {
  const b = req.body || {};
  const patch: { mode?: string | null; ownerKey?: string | null; autoWhitelist?: boolean | null } = {};

  if ('mode' in b) {
    if (b.mode === null) patch.mode = null;
    else if (typeof b.mode === 'string') {
      // valide : sous-ensemble de {DIRECT,MFP,LOCAL} séparé par ; ou ,
      const toks = b.mode.split(/[;,]/).map((s: string) => s.trim().toLowerCase()).filter(Boolean);
      if (!toks.every((t: string) => t in MODE_ALIAS)) {
        return res.status(400).json({ ok: false, error: 'mode invalide (DIRECT/MFP/LOCAL)' });
      }
      patch.mode = toks.map((t: string) => t.toUpperCase()).join(';');
    }
  }
  if ('autoWhitelist' in b) {
    if (b.autoWhitelist === null) patch.autoWhitelist = null;
    else if (typeof b.autoWhitelist === 'boolean') patch.autoWhitelist = b.autoWhitelist;
    else return res.status(400).json({ ok: false, error: 'autoWhitelist doit être un booléen' });
  }
  if ('ownerKey' in b) {
    if (b.ownerKey === null || b.ownerKey === '') patch.ownerKey = null;
    else if (typeof b.ownerKey === 'string' && b.ownerKey.length >= 8 && b.ownerKey.length <= 128) {
      patch.ownerKey = b.ownerKey;
    } else return res.status(400).json({ ok: false, error: 'ownerKey : 8 à 128 caractères' });
  }

  updateSettings(patch);
  return res.json({ ok: true, ...settingsView() });
});
```

Note : `MODE_ALIAS` existe déjà dans `index.ts` (utilisé par `allowedModes`). Vérifier qu'il mappe `direct/mfp/mediaflow/local`.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: `tsc` sans erreur (vérifier qu'aucun autre fichier n'importe encore `AUTO_WHITELIST` comme const).

- [ ] **Step 6: Commit**

```bash
git add src/access.ts src/proxy.ts src/index.ts
git commit -m "feat(admin): mode/ownerKey/autoWhitelist appliqués à chaud + endpoints /api/settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Réécrire `src/admin.html` — SPA sidebar 4 vues

**Files:**
- Modify: `src/admin.html` (réécriture complète)

**Interfaces:**
- Consomme les endpoints : `/api/stats`, `/api/cache/stats`, `/api/health`, `/api/logs`, `/api/settings` (GET/POST), `/api/whitelist` (GET/POST), `/api/<src>/endpoints` (GET/POST), `/admin/logout`.

Structure :
- **Layout** : `<aside>` sidebar fixe (logo LooStream + nav : Dashboard · Stats · Logs · Paramétrage + bouton Déconnexion en bas) + `<main>` avec 4 `<section class="view" data-view="...">`, une seule visible (`.active`). Bascule JS `showView(name)` (au clic nav + `location.hash`).
- **Palette** : conserver `#1a1a2e`/`#16213e` (fond), accent `#7f5af0`, cartes `#16213e`. Statuts 🟢 `#2cb67d` / 🟡 `#ff8906` / 🔴 `#e53170`.
- **Dashboard** : rangée de KPIs (uptime, requêtes total, streams servis, cache hit-rate) + grille de cartes santé par source (couleur selon `metrics[src].status`, `statusReason` en sous-titre) + bouton « Health-check live » qui appelle `/api/health` et colore les pastilles.
- **Stats** : réutilise les barres 20-slots (`buildScraperCard` existant, à reprendre) par source ; cartes cache (par scope depuis `/api/cache/stats`), requêtes, streams servis par source (`stats.sources`).
- **Logs** : barre de filtres (select source [rempli depuis `sources`], select niveau [info/warn/error], input recherche, toggle auto-refresh) + `<pre>`/liste défilante colorée par niveau. Poll `/api/logs?sinceSeq=<lastSeq>&...` toutes les 3 s quand auto-refresh actif ; append incrémental ; garde ≤1000 lignes DOM. Changement de filtre → reset (`sinceSeq=0`).
- **Paramétrage** : onglets internes (Sources · Whitelist · Partage).
  - *Sources* : éditeur endpoints existant (SOURCES array movix[api,referer,origin]/frenchstream/streamflix/videasy/voirdrama/voiranime/nabistream/coflix ; `saveEndpoint` POST).
  - *Whitelist* : liste + ajout (`loadWhitelist`/`addDomain`) + **toggle AUTO_WHITELIST** (POST `/api/settings {autoWhitelist}`) avec badge état/source.
  - *Partage* : cases à cocher MODE (DIRECT/MFP/LOCAL) → POST `/api/settings {mode}` ; champ OWNER_KEY (affiché « configurée (N caractères) » ou « non configurée » depuis `settingsView`, jamais la valeur) avec bouton 🎲 (génère hex 32 côté client via `crypto.getRandomValues`) → POST `{ownerKey}`, et bouton « Retirer » → POST `{ownerKey:null}`. ACCESS_KEY affichée en lecture seule (« activée »/« désactivée » — pas d'édition).
- **Auth** : inchangée (la page est déjà servie derrière `requireAdminSession` ; un 401/302 sur un fetch → `location = '/admin/login'`).

- [ ] **Step 1: Réécrire `src/admin.html`** avec la structure ci-dessus. Récupérer les helpers existants (`buildScraperCard`, `loadStats`, `loadWhitelist`, `addDomain`, `saveEndpoint`, `SOURCES`) depuis l'ancienne version (git show HEAD:src/admin.html) et les replacer dans les vues Dashboard/Stats/Paramétrage. Ajouter le JS des vues Logs et Partage.

- [ ] **Step 2: Build (copie admin.html dans dist)**

Run: `npm run build`
Expected: `dist/admin.html` mis à jour (le build copie les .html). Vérifier : `ls -la dist/admin.html`.

- [ ] **Step 3: Vérif statique du HTML** — pas de test auto ; relire la page pour : une seule vue `.active` au chargement, tous les `fetch` gèrent l'échec (redirection login), aucun secret affiché.

- [ ] **Step 4: Commit**

```bash
git add src/admin.html
git commit -m "feat(admin): espace admin multi-pages (sidebar : dashboard, stats, logs, paramétrage)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Build image + vérification d'intégration

**Files:** aucun (validation).

- [ ] **Step 1: Build complet + rebuild conteneur**

Run: `npm run build && docker compose up -d --build loostream && docker compose logs --tail=20 loostream`
Expected: démarrage OK, log `LooStream Addon running`.

- [ ] **Step 2: Vérifier les endpoints (avec une session admin)**

Ouvrir une session : `curl -s -c /tmp/adm.txt -d "user=$ADMIN_USER&pass=$ADMIN_PASS" http://localhost:7002/admin/login` puis :
```bash
curl -s -b /tmp/adm.txt http://localhost:7002/api/logs | head -c 300      # { lines, lastSeq, sources }
curl -s http://localhost:7002/api/settings                                 # settingsView (pas de clé en clair)
curl -s -b /tmp/adm.txt -H 'Content-Type: application/json' \
  -d '{"autoWhitelist":true}' http://localhost:7002/api/settings           # ok:true, autoWhitelist:true
```
Expected : `/api/logs` renvoie des lignes (le boot a écrit dedans) ; `/api/settings` ne contient jamais la valeur OWNER_KEY ; le POST applique le toggle.

- [ ] **Step 3: Vérifier l'application à chaud** — après le POST `autoWhitelist:true`, `GET /api/whitelist` doit renvoyer `autoWhitelist:true` (même process, getter partagé). Reposer `{"autoWhitelist":null}` pour revenir au `.env`.

- [ ] **Step 4: Vérif masquage secrets dans les logs** — provoquer une ligne contenant la clé (ex. un appel proxy signé) et confirmer via `/api/logs?q=k=` que la valeur apparaît en `***`.

- [ ] **Step 5: Vérif visuelle** — l'utilisateur ouvre `/admin`, navigue Dashboard/Stats/Logs/Paramétrage, teste le toggle AUTO_WHITELIST, le MODE, le 🎲 OWNER_KEY. (Validation utilisateur — je ne merge pas avant.)

- [ ] **Step 6: Nettoyage runtime-settings de test** — remettre `config/runtime-settings.json` à `{ "_comment": ... }` avant merge si des valeurs de test ont été écrites (ce fichier ne doit pas embarquer de secret de test dans le commit ; décider avec l'utilisateur s'il est versionné ou gitignoré — cf. Notes).

---

## Notes de fin

- **`config/runtime-settings.json` versionné ?** Il est bind-mount comme les autres `config/*.json`. On versionne le squelette (`{_comment}`) ; s'il finit par contenir une OWNER_KEY réelle en prod, envisager de l'ajouter à `.gitignore` (comme `.env`). À trancher avec l'utilisateur au moment du merge.
- **Précédence** : un réglage posé via l'admin (fichier) gagne sur le `.env`. Pour « revenir au .env », l'admin envoie `null` (retire la clé du fichier).
- **Pas de nouvelle dépendance** ; tout est vanilla + Express existant.

## Self-Review (fait)

- **Couverture spec** : logbuffer (T1-2), settings (T3-4), 4 vues admin (T5), sécurité/masquage (T1 + T6 step 4), toggles hot-reload (T4 + T6 step 3). ✓
- **Placeholders** : aucun — code réel fourni à chaque étape. ✓
- **Cohérence des types** : `getLogs`/`pushLog`/`LogLine`, `getModeRaw`/`getOwnerKeyValue`/`autoWhitelistEnabled`/`updateSettings`/`settingsView` identiques entre définition (T1/T3) et usage (T2/T4). ✓

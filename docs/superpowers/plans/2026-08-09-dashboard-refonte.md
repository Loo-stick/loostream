# Refonte dashboard + pseudo + logs par utilisateur — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un système de pseudo (optionnel), un tracking Users persistant en SQLite avec logs détaillés par requête, une vue dashboard « Utilisateurs », et refondre le visuel du dashboard + la page configure (assistant 4 étapes).

**Architecture:** Backend Express hand-rolled existant. Nouveau module `src/user-activity.ts` (better-sqlite3, base `config/users.db` bind-montée). Capture des logs par requête via `AsyncLocalStorage` (wrap de `console.log`). Endpoints admin-gated. Deux pages HTML statiques (admin.html, configure.html) restylées, servies telles quelles.

**Tech Stack:** TypeScript strict, Express, better-sqlite3 (^12.9.0, synchrone), node:test + tsx pour les tests, HTML/CSS/JS inline pour les pages.

## Global Constraints
- **Aucun `git push` sans l'aval explicite de Stick.** Commits locaux OK. Cf. [[test-before-push]].
- `tsc --strict` doit passer : la vérif de compilation est `npm run build`.
- Ne **jamais** committer la dérive de `config/*.json` (bind-montés) ni `.env`.
- Commits en **français**, conventionnels, terminés par `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Rétro-compat** : une URL d'install base64 sans `pseudo` doit continuer à marcher (→ `(anonyme)`).
- **Rétention 30 j** pour `user_activity` ; `log` capturé systématiquement pour les problèmes, sinon selon le toggle `captureAllLogs`.
- Déployer (`docker compose up -d --build loostream`) pour que Stick teste ; valider avant tout merge/tag.
- Lancer un test unitaire isolé : `node --import tsx --test --test-force-exit src/<fichier>.test.ts`.

## File Structure
- `src/user-activity.ts` — **NOUVEAU** : module SQLite (schéma `detail`+`log`, `recordUserActivity`, `getUsersOverview`, `getUserRequests`, `getRequestLog`, purge). Responsabilité unique : persistance + agrégation de l'activité.
- `src/request-log.ts` — **NOUVEAU** : capture de logs par requête (`AsyncLocalStorage`, `runWithLogCapture`, `capturedLines`, `currentPseudo`). Isolé pour être testable et réutilisable.
- `src/pseudo.ts` — **NOUVEAU** : `sanitizePseudo`, `pseudoLabel` (pur, testable).
- `src/settings.ts` — ajout du toggle `captureAllLogs`.
- `src/index.ts` — `UserConfig.pseudo`, câblage `parseConfig`, capture + tagging dans `handleStream`, `recordUserActivity`, endpoints `/api/users*`.
- `src/admin.html` — vue « Utilisateurs » + restyle global + toggle capture-all.
- `src/configure.html` — refonte assistant 4 étapes + champ pseudo.

---

## Phase 1 — Pseudo (pur)

### Task 1: `sanitizePseudo` / `pseudoLabel`

**Files:**
- Create: `src/pseudo.ts`
- Test: `src/pseudo.test.ts`

**Interfaces:**
- Produces: `sanitizePseudo(raw: unknown): string` (chaîne nettoyée, possiblement vide) ; `pseudoLabel(raw: unknown): string` (nettoyée ou `'(anonyme)'`).

- [ ] **Step 1: Écrire le test qui échoue** — `src/pseudo.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { sanitizePseudo, pseudoLabel } from './pseudo';

test('sanitizePseudo: trim + longueur max 24', () => {
  assert.equal(sanitizePseudo('  Wallace  '), 'Wallace');
  assert.equal(sanitizePseudo('x'.repeat(40)).length, 24);
});
test('sanitizePseudo: retire les caractères non autorisés, garde lettres/chiffres/espace/_.-', () => {
  assert.equal(sanitizePseudo('Wa/ll<ace>'), 'Wallace');
  assert.equal(sanitizePseudo('Jean-Luc_92.x'), 'Jean-Luc_92.x');
  assert.equal(sanitizePseudo('Éléa 🎬'), 'Éléa');
});
test('pseudoLabel: vide -> (anonyme)', () => {
  assert.equal(pseudoLabel(''), '(anonyme)');
  assert.equal(pseudoLabel(undefined), '(anonyme)');
  assert.equal(pseudoLabel('   '), '(anonyme)');
  assert.equal(pseudoLabel('Wallace'), 'Wallace');
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `node --import tsx --test --test-force-exit src/pseudo.test.ts`
Expected: FAIL (`Cannot find module './pseudo'`).

- [ ] **Step 3: Implémenter** — `src/pseudo.ts`

```ts
// Pseudo optionnel auto-déclaré par l'utilisateur (dans configure), embarqué dans la
// config base64. Nettoyé avant tout usage (log/BDD) : lettres/chiffres/espace/_.- ,
// longueur bornée. Vide -> traité comme absent via pseudoLabel().
const ALLOWED = /[^\p{L}\p{N} _.\-]/gu;

export function sanitizePseudo(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(ALLOWED, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

export function pseudoLabel(raw: unknown): string {
  const p = sanitizePseudo(raw);
  return p.length ? p : '(anonyme)';
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `node --import tsx --test --test-force-exit src/pseudo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pseudo.ts src/pseudo.test.ts
git commit -m "$(printf 'feat(pseudo): sanitizePseudo + pseudoLabel (optionnel, fallback anonyme)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Phase 2 — Tracking SQLite

### Task 2: Module `user-activity.ts`

**Files:**
- Create: `src/user-activity.ts`
- Test: `src/user-activity.test.ts`

**Interfaces:**
- Consumes: better-sqlite3.
- Produces:
  - `recordUserActivity(pseudo: string, e: { mediaType?: string; contentId?: string; title?: string; streams: number; outcome: 'ok'|'empty'|'error'; detail?: string; log?: string|null }): void`
  - `getUsersOverview(): Array<{ pseudo; lastSeen; requests; empties; errors; recentProblems }>`
  - `getUserRequests(pseudo: string, limit?: number): Array<{ id; title; mediaType; contentId; streams; outcome; detail; ts }>`
  - `getRequestLog(id: number): string | null`
  - `purgeOldActivity(): number`
  - Chemin BDD surchargable par `process.env.USERS_DB` (pour les tests).

- [ ] **Step 1: Écrire le test qui échoue** — `src/user-activity.test.ts`

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DB = path.join(os.tmpdir(), `ua-test-${process.pid}.db`);
process.env.USERS_DB = DB;
// import APRÈS avoir posé USERS_DB (le module ouvre la base à l'import)
const ua = await import('./user-activity');

after(() => { try { fs.unlinkSync(DB); } catch {} });

test('record + overview: agrège par pseudo, compte vides/erreurs', () => {
  ua.recordUserActivity('Wallace', { title: 'A', streams: 0, outcome: 'empty', detail: '{}' });
  ua.recordUserActivity('Wallace', { title: 'B', streams: 4, outcome: 'ok', detail: '{}' });
  ua.recordUserActivity('Stick', { title: 'C', streams: 2, outcome: 'ok', detail: '{}' });
  const ov = ua.getUsersOverview();
  const w = ov.find(u => u.pseudo === 'Wallace')!;
  assert.equal(w.requests, 2);
  assert.equal(w.empties, 1);
  assert.equal(w.errors, 0);
});

test('getUserRequests + getRequestLog: trace récupérable par id', () => {
  ua.recordUserActivity('Kevin', { title: 'D', streams: 0, outcome: 'error', detail: '{"movix":{"streams":0}}', log: '[Stream] No streams found' });
  const reqs = ua.getUserRequests('Kevin', 10);
  assert.equal(reqs[0].title, 'D');
  assert.equal(reqs[0].outcome, 'error');
  assert.match(reqs[0].detail, /movix/);
  const log = ua.getRequestLog(reqs[0].id);
  assert.match(log!, /No streams found/);
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `node --import tsx --test --test-force-exit src/user-activity.test.ts`
Expected: FAIL (module absent).

- [ ] **Step 3: Implémenter** — `src/user-activity.ts`

```ts
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// Base dédiée (séparée de cache.db) — bind-montée dans config/ => survit au recreate.
const DB_PATH = process.env.USERS_DB ||
  (fs.existsSync('/app/config') ? '/app/config/users.db'
    : path.join(process.cwd(), 'config', 'users.db'));

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS user_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pseudo TEXT NOT NULL, media_type TEXT, content_id TEXT, title TEXT,
    streams INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL,
    detail TEXT, log TEXT, ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ua_pseudo ON user_activity(pseudo);
  CREATE INDEX IF NOT EXISTS idx_ua_ts ON user_activity(ts);
`);

const insertStmt = db.prepare(
  `INSERT INTO user_activity (pseudo, media_type, content_id, title, streams, outcome, detail, log, ts)
   VALUES (@pseudo,@media_type,@content_id,@title,@streams,@outcome,@detail,@log,@ts)`
);

export function recordUserActivity(pseudo: string, e: {
  mediaType?: string; contentId?: string; title?: string;
  streams: number; outcome: 'ok'|'empty'|'error'; detail?: string; log?: string | null;
}): void {
  try {
    insertStmt.run({
      pseudo, media_type: e.mediaType ?? null, content_id: e.contentId ?? null,
      title: e.title ?? null, streams: e.streams | 0, outcome: e.outcome,
      detail: e.detail ?? null, log: e.log ? e.log.slice(0, 8192) : null, ts: Date.now(),
    });
  } catch (err: any) { console.error('[UserActivity] insert failed:', err.message); }
}

const overviewStmt = db.prepare(`
  SELECT pseudo, MAX(ts) lastSeen, COUNT(*) requests,
    SUM(outcome='empty') empties, SUM(outcome='error') errors,
    SUM((outcome IN ('empty','error')) AND ts > ?) recentProblems
  FROM user_activity GROUP BY pseudo
  ORDER BY recentProblems DESC, lastSeen DESC
`);
export function getUsersOverview() {
  return overviewStmt.all(Date.now() - 7 * 24 * 60 * 60 * 1000) as any[];
}

const requestsStmt = db.prepare(
  `SELECT id, title, media_type mediaType, content_id contentId, streams, outcome, detail, ts
   FROM user_activity WHERE pseudo = ? ORDER BY ts DESC LIMIT ?`
);
export function getUserRequests(pseudo: string, limit = 20) {
  return requestsStmt.all(pseudo, limit) as any[];
}

const logStmt = db.prepare('SELECT log FROM user_activity WHERE id = ?');
export function getRequestLog(id: number): string | null {
  const r = logStmt.get(id) as { log: string | null } | undefined;
  return r?.log ?? null;
}

const purgeStmt = db.prepare('DELETE FROM user_activity WHERE ts < ?');
export function purgeOldActivity(): number {
  return purgeStmt.run(Date.now() - RETENTION_MS).changes;
}
setInterval(() => {
  const n = purgeOldActivity();
  if (n > 0) console.log(`[UserActivity] purged ${n} old rows`);
}, 6 * 60 * 60 * 1000).unref();
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `node --import tsx --test --test-force-exit src/user-activity.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/user-activity.ts src/user-activity.test.ts
git commit -m "$(printf 'feat(users): module SQLite user_activity (record/overview/requests/log/purge 30j)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Phase 3 — Capture de logs par requête

### Task 3: Module `request-log.ts`

**Files:**
- Create: `src/request-log.ts`
- Test: `src/request-log.test.ts`

**Interfaces:**
- Produces:
  - `runWithLogCapture<T>(pseudo: string, fn: () => Promise<T>): Promise<T>`
  - `capturedLines(): string` (trace de la requête courante, `''` hors contexte)
  - `currentPseudo(): string | undefined`
  - `installLogCapture(): void` (wrap `console.log` une fois, au boot)

- [ ] **Step 1: Écrire le test qui échoue** — `src/request-log.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { runWithLogCapture, capturedLines, currentPseudo, installLogCapture } from './request-log';

installLogCapture();

test('capture les console.log DANS le contexte, pas dehors', async () => {
  console.log('hors-contexte'); // ne doit pas apparaître
  const cap = await runWithLogCapture('Wallace', async () => {
    console.log('[Movix] Purstream=0');
    console.log('[Stream] No streams found');
    assert.equal(currentPseudo(), 'Wallace');
    return capturedLines();
  });
  assert.match(cap, /\[Movix\] Purstream=0/);
  assert.match(cap, /No streams found/);
  assert.doesNotMatch(cap, /hors-contexte/);
  assert.equal(capturedLines(), ''); // hors contexte après
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `node --import tsx --test --test-force-exit src/request-log.test.ts`
Expected: FAIL (module absent).

- [ ] **Step 3: Implémenter** — `src/request-log.ts`

```ts
import { AsyncLocalStorage } from 'async_hooks';

type Ctx = { pseudo: string; lines: string[] };
const als = new AsyncLocalStorage<Ctx>();
const MAX_LINES = 200;
let installed = false;

function hhmmss(): string {
  return new Date().toTimeString().slice(0, 8);
}

// Wrap console.log UNE fois : écrit toujours sur stdout, ET pousse dans le buffer du
// contexte de requête courant (s'il existe). Hors requête -> aucun effet.
export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  const orig = console.log.bind(console);
  console.log = (...args: any[]) => {
    orig(...args);
    const ctx = als.getStore();
    if (ctx && ctx.lines.length < MAX_LINES) {
      ctx.lines.push(`${hhmmss()} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`);
    }
  };
}

export function runWithLogCapture<T>(pseudo: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ pseudo, lines: [] }, fn);
}
export function capturedLines(): string {
  const c = als.getStore();
  return c ? c.lines.join('\n') : '';
}
export function currentPseudo(): string | undefined {
  return als.getStore()?.pseudo;
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `node --import tsx --test --test-force-exit src/request-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/request-log.ts src/request-log.test.ts
git commit -m "$(printf 'feat(users): capture de logs par requete via AsyncLocalStorage\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Phase 4 — Câblage backend

### Task 4: `captureAllLogs` dans settings

**Files:**
- Modify: `src/settings.ts`

**Interfaces:**
- Produces: `captureAllLogsEnabled(): boolean` ; champ `captureAllLogs?: boolean` dans `RuntimeSettings`, géré par `updateSettings` et exposé par `settingsView()`.

- [ ] **Step 1:** Ajouter `captureAllLogs?: boolean` à `RuntimeSettings`, au `load()`, à `updateSettings` (via `apply`), et le getter :
```ts
export function captureAllLogsEnabled(): boolean {
  const s = load();
  return s.captureAllLogs !== undefined ? s.captureAllLogs : (process.env.CAPTURE_ALL_LOGS === 'true');
}
```
Ajouter `captureAllLogs` + source à `settingsView()` (sur le modèle de `netfreeSocksPool`).

- [ ] **Step 2:** Vérifier la compilation.
Run: `npm run build`
Expected: BUILD OK (pas d'erreur TS).

- [ ] **Step 3: Commit**
```bash
git add src/settings.ts
git commit -m "$(printf 'feat(settings): toggle captureAllLogs (defaut off)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

### Task 5: Câbler pseudo + capture + record dans `handleStream`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `pseudoLabel` (Task 1), `runWithLogCapture`/`capturedLines`/`installLogCapture` (Task 3), `recordUserActivity` (Task 2), `captureAllLogsEnabled` (Task 4).

- [ ] **Step 1:** Ajouter `pseudo?: string;` à `interface UserConfig`. Dans `parseConfig()`, après le parse base64, normaliser : `if (cfg.pseudo !== undefined) cfg.pseudo = sanitizePseudo(cfg.pseudo);` (importer `sanitizePseudo`).

- [ ] **Step 2:** Au boot (près de l'init du serveur), appeler `installLogCapture()` une fois. Importer depuis `./request-log`.

- [ ] **Step 3:** Envelopper le corps de `handleStream` dans `runWithLogCapture(pseudoLabel(config), async () => { … })`. Taguer la ligne de titre existante :
```ts
console.log(`[Stream] 👤 ${pseudoLabel(config)} · Title: ${info.title} (${info.year})`);
```

- [ ] **Step 4:** Construire `perSourceSummary` depuis les résultats déjà collectés du fan-out (`SOURCE_NAMES` + `collected`), objet `{ [source]: { streams: n } }`, `JSON.stringify`. À la fin du handler (juste avant d'envoyer la réponse ET dans le `catch`), appeler :
```ts
const outcome = errored ? 'error' : (finalStreams.length > 0 ? 'ok' : 'empty');
recordUserActivity(pseudoLabel(config), {
  mediaType: type, contentId: id, title: info?.title,
  streams: finalStreams.length, outcome,
  detail: JSON.stringify(perSourceSummary),
  log: (outcome !== 'ok' || captureAllLogsEnabled()) ? capturedLines() : null,
});
```
(Placer l'appel de façon à couvrir succès, `0 stream`, et exception.)

- [ ] **Step 5:** Vérifier la compilation puis déployer + sonde manuelle.
Run: `npm run build && docker compose up -d --build loostream`
Run (sonde ; remplace `<OCFG>` par une config base64 avec `"pseudo":"TestUser"`) :
```bash
curl -sS -H "X-Forwarded-Proto: https" -H "X-Forwarded-Host: streamzz.loostick.ovh" \
  "http://localhost:7002/<OCFG>/stream/series/tt5607976:2:2.json" > /dev/null
docker compose logs --since 30s loostream | grep "👤 TestUser"
```
Expected: la ligne `[Stream] 👤 TestUser · Title: …` apparaît, et une ligne s'ajoute dans `users.db`.

- [ ] **Step 6: Commit**
```bash
git add src/index.ts
git commit -m "$(printf 'feat(users): pseudo dans UserConfig + capture/record par requete dans handleStream\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

### Task 6: Endpoints `/api/users*`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `getUsersOverview`, `getUserRequests`, `getRequestLog` (Task 2) ; `requireAdminSession` (existant, cf. `/api/sources`).

- [ ] **Step 1:** Ajouter, à côté des autres endpoints admin :
```ts
app.get('/api/users', requireAdminSession, (_req, res) => res.json({ users: getUsersOverview() }));
app.get('/api/users/request/:id', requireAdminSession, (req, res) => {
  const log = getRequestLog(Number(req.params.id));
  res.json({ log });
});
app.get('/api/users/:pseudo', requireAdminSession, (req, res) =>
  res.json({ requests: getUserRequests(req.params.pseudo) }));
```
(Déclarer `/request/:id` AVANT `/:pseudo` pour éviter que `request` soit capturé comme pseudo.)

- [ ] **Step 2:** Vérifier build + sonde (session admin requise) :
```bash
npm run build && docker compose up -d --build loostream
# via un cookie de session admin valide :
curl -sS -b "<cookie-admin>" "http://localhost:7002/api/users" | head -c 300
```
Expected: JSON `{"users":[…]}` trié problèmes en tête.

- [ ] **Step 3: Commit**
```bash
git add src/index.ts
git commit -m "$(printf 'feat(users): endpoints admin /api/users (overview, requetes, log par id)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Phase 5 — Vue dashboard « Utilisateurs » + restyle

### Task 7: Vue « Utilisateurs » (fonctionnelle)

**Files:**
- Modify: `src/admin.html`

Note : `admin.html` sert la SPA admin ; on suit le pattern existant des autres vues (`data-view`, `showView`, `loadSources`). Pas de test unitaire UI → vérification par build + rendu (Stick).

- [ ] **Step 1:** Ajouter l'entrée nav `👥 Utilisateurs` (`data-view="users"`) et la section `id="view-users"` ; enregistrer `users` dans la liste des vues valides et le `switch showView`.

- [ ] **Step 2:** `loadUsers()` : `fetch('/api/users')` → rend la table (Pseudo, Vu, Req., Vides, Erreurs), tri déjà fait côté serveur, drapeau rouge si `recentProblems>0`. Clic ligne → `loadUserDetail(pseudo)`.

- [ ] **Step 3:** `loadUserDetail(pseudo)` : `fetch('/api/users/'+encodeURIComponent(pseudo))` → panneau « Requêtes récentes », chaque requête dépliable ; au dépli, `fetch('/api/users/request/'+id)` → injecte la trace `log` dans un bloc mono. Résumé par source rendu depuis `detail` (JSON parsé).

- [ ] **Step 4:** Câbler `showView('users')` → `loadUsers()`. Build + déploiement, vérifier le rendu réel (Stick teste).
Run: `npm run build && docker compose up -d --build loostream`

- [ ] **Step 5: Commit**
```bash
git add src/admin.html
git commit -m "$(printf 'feat(dashboard): vue Utilisateurs (table + requetes depliables + logs par requete)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

### Task 8: Restyle dashboard + toggle capture-all

**Files:**
- Modify: `src/admin.html`

Direction visuelle = celle validée dans le mockup (`scratchpad/loostream-mockup.html`) : thème sombre bleuté, tokens CSS centralisés, cartes, pastilles d'état, mono sur la donnée. **REQUIRED SUB-SKILL au moment de coder : frontend-design.**

- [ ] **Step 1:** Introduire les tokens CSS (couleurs/typo/rayons) repris du mockup, en variables `:root`, et restyler les vues existantes (Dashboard/Sources/Stats/Paramétrage/Logs) sans changer leur logique JS/fetch.
- [ ] **Step 2:** Ajouter le toggle `captureAllLogs` dans la vue Paramétrage (POST `/api/settings`, sur le modèle des toggles existants).
- [ ] **Step 3:** Build + déploiement, contrôle visuel (Stick).
Run: `npm run build && docker compose up -d --build loostream`
- [ ] **Step 4: Commit**
```bash
git add src/admin.html
git commit -m "$(printf 'feat(dashboard): restyle sombre + toggle captureAllLogs\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Phase 6 — Refonte page configure (wizard)

### Task 9: Assistant 4 étapes + champ pseudo

**Files:**
- Modify: `src/configure.html`

**REQUIRED SUB-SKILL : frontend-design.** Direction = mockup validé.

- [ ] **Step 1:** Restructurer en 4 étapes (Mode → Clés → Préférences → Pseudo+lien) avec indicateur de progression et navigation Retour/Continuer. **Réutiliser tous les champs existants** (proxy, mfUrl, mfPass, tmdbKey, accessKey, prefQuality, langOrder, minStreams, sortBy) — aucun champ retiré.

- [ ] **Step 2:** Ajouter le champ `pseudo` (étape 4). L'inclure dans l'objet config sérialisé en base64 **uniquement s'il est non vide** (rétro-compat : URL sans pseudo inchangée). Le reste de la génération d'URL (copier / ouvrir Stremio) est repris tel quel.

- [ ] **Step 3:** Appliquer les tokens visuels (cohérence avec le dashboard). Build + déploiement + vérif du base64 généré.
Run: `npm run build && docker compose up -d --build loostream`
Vérif : ouvrir `/configure`, générer une URL avec pseudo « TestUser », décoder le base64 → doit contenir `"pseudo":"TestUser"` ET tous les champs habituels ; générer sans pseudo → base64 SANS clé `pseudo`, et l'install fonctionne (→ `(anonyme)`).

- [ ] **Step 4: Commit**
```bash
git add src/configure.html
git commit -m "$(printf 'feat(configure): assistant 4 etapes + champ pseudo (retro-compatible)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Vérification finale (avant de proposer à Stick de tester)
- [ ] `npm run build` → OK (tsc strict).
- [ ] `npm test` → les tests `pseudo`/`user-activity`/`request-log` passent (ignorer le hang connu du test animesama, non lié).
- [ ] Déploiement OK ; une recherche avec pseudo apparaît dans les logs ET dans la vue Utilisateurs, avec sa trace dépliable.
- [ ] Redémarrage (`docker compose up -d --build`) → les données Users **persistent** (`config/users.db`).
- [ ] Une ancienne URL d'install (sans pseudo) fonctionne, l'utilisateur apparaît `(anonyme)`.
- [ ] **STOP — ne rien pousser.** Prévenir Stick, livrer un rapport, attendre son test + son feu vert explicite pour tout `git push`/merge/tag. Cf. [[test-before-push]].

## Notes de decomposition
- Chaque phase produit un incrément testable. Phases 1–3 sont des modules purs (tests unitaires). Phases 4–6 se vérifient par build + sonde curl + rendu (Stick), le repo n'ayant pas de harnais de test UI/HTTP.
- `config/users.db` doit être couvert par le bind-mount `config/` du `docker-compose.yml` (déjà le cas pour `cache.db`) → vérifier au passage qu'aucune règle ne l'exclut.

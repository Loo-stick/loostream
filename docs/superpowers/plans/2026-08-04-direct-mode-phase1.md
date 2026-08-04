# Mode Direct hybride — Phase 1 — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Ajouter `proxy:'direct'` : livrer l'URL CDN brute + `behaviorHints.proxyHeaders` (0 bande passante serveur) pour les hôtes directables ; repli proxy local pour NetMirror (`forceLocal`) et les hôtes FAI-bloqués.

**Architecture:** Un helper `deliver()` remplace les appels `buildProxyUrl()` inline des 8 blocs sources et renvoie `{url, proxyHeaders?}`. En mode direct, `proxyHeaders` est posé sur le draft (Stremio natif fetch en direct). NetMirror/MovieBox inchangés. DoH = Phase 2.

**Tech Stack:** TypeScript, Express, `node:test` + `tsx`.

## Global Constraints
- Rétro-compat : `proxy` autre que `'direct'` → **comportement actuel strictement inchangé**.
- Pas de nouvelle dépendance.
- Tests via `npm test` (node:test + tsx), build via `npm run build` (tsc strict).
- Commits en français, style conventionnel, `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1 : Config — accepter `'direct'` + type `proxyHeaders`

**Files:**
- Modify: `src/index.ts` (interface `UserConfig` ~117 ; `parseConfig` validation ~175 ; type `behaviorHints` ~133)
- Test: `src/index.test.ts` (nouveau si absent) — parseConfig

**Interfaces produites:** `UserConfig.proxy: 'local'|'mediaflow'|'direct'` ; `behaviorHints.proxyHeaders?: { request: Record<string,string> }`.

- [ ] **Step 1 — test qui échoue** (`src/access.test.ts` a déjà le pattern ; créer `src/parseconfig.test.ts` en exportant `parseConfig`… mais parseConfig n'est pas exporté). **Décision** : rendre `parseConfig` exporté et écrire le test :
```ts
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { parseConfig } from './index';
const b64 = (o:any)=>Buffer.from(JSON.stringify(o)).toString('base64');
test("parseConfig accepte proxy:'direct'", () => {
  const c = parseConfig(b64({ proxy:'direct', tmdbKey:'x' }));
  assert.equal(c?.proxy, 'direct');
});
test("parseConfig rejette un proxy inconnu", () => {
  assert.equal(parseConfig(b64({ proxy:'bogus' })), null);
});
```
⚠️ Importer `./index` exécute `app.listen`. **Éviter** : ne PAS tester via import d'index (effets de bord serveur). **Alternative retenue** : extraire `parseConfig` + les constantes dans un module pur `src/config.ts` et tester celui-ci. Voir Step 3.

- [ ] **Step 2 — vérifier l'échec** : `npm test` → FAIL (module `src/config.ts` absent).

- [ ] **Step 3 — implémentation minimale** : créer `src/config.ts` avec `UserConfig` + `parseConfig` + `sanitizeString`/`isValidUrl` (déplacés depuis index.ts), `proxy` incluant `'direct'`, validation `['local','mediaflow','direct'].includes(parsed.proxy)`. Dans `src/index.ts` : `import { UserConfig, parseConfig } from './config';` et retirer les définitions déplacées. Étendre le type draft `behaviorHints` avec `proxyHeaders?: { request: Record<string,string> }`.
```ts
// src/config.ts (extrait clé)
export interface UserConfig { proxy: 'local'|'mediaflow'|'direct'; mfUrl?:string; mfPass?:string; tmdbKey?:string; accessKey?:string; prefQuality?:string; langOrder?:string[]; minStreams?:number; }
// dans parseConfig :
if (!['local','mediaflow','direct'].includes(parsed.proxy)) return null;
```

- [ ] **Step 4 — vérifier le succès** : `npm test` → PASS (nouveaux tests + les 41 existants).
- [ ] **Step 5 — build** : `npm run build` → OK.
- [ ] **Step 6 — commit** : `git add -A && git commit -m "feat(config): proxy:'direct' + type proxyHeaders (module config.ts pur)"`

---

### Task 2 : Helper `deliver()` + `isDirectable`

**Files:**
- Modify: `src/index.ts` (près de `buildProxyUrl`, ~458)
- Test: `src/deliver.test.ts`

**Interfaces:**
- Consumes: `buildProxyUrl` (existant), `UserConfig`.
- Produces:
```ts
const PROXY_FORCED_HOSTS: string[]  // motifs d'hôtes FAI-bloqués
function isDirectable(streamUrl: string): boolean
function deliver(streamUrl: string, headers: Record<string,string>,
  opts: { forceLocal?: boolean; forceHls?: boolean; useTransformer?: boolean },
  req: express.Request, config: UserConfig | null
): { url: string; proxyHeaders?: Record<string,string> } | null
```

- [ ] **Step 1 — test qui échoue** (`src/deliver.test.ts`). `deliver`/`isDirectable` doivent être exportés. Comme ils dépendent de `buildProxyUrl` (lié à `req`), tester **`isDirectable` seul** (pur) + la **décision** via une petite fonction pure extraite `directDecision(streamUrl, forceLocal, proxy)`:
```ts
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { isDirectable, directDecision } from './deliver';
test('isDirectable: hôte normal OK, hôte FAI-bloqué non', () => {
  assert.equal(isDirectable('https://cuyyro.premilkyway.com/x.m3u8'), true);
  assert.equal(isDirectable('https://strm2.uqload.is/x.m3u8'), false);
  assert.equal(isDirectable('pas-une-url'), false);
});
test('directDecision: direct seulement si mode direct + directable + pas forceLocal', () => {
  assert.equal(directDecision('https://a.premilkyway.com/x', false, 'direct'), true);
  assert.equal(directDecision('https://a.premilkyway.com/x', true,  'direct'), false); // NetMirror
  assert.equal(directDecision('https://strm2.uqload.is/x',    false, 'direct'), false); // bloqué
  assert.equal(directDecision('https://a.premilkyway.com/x', false, 'local'),  false);
});
```

- [ ] **Step 2 — vérifier l'échec** : `npm test` → FAIL (`src/deliver.ts` absent).

- [ ] **Step 3 — implémentation** : créer `src/deliver.ts` :
```ts
import type * as express from 'express';
import type { UserConfig } from './config';

// Hôtes bloqués par les FAI FR (DNS -> ::1) ou morts en direct -> forcés sur le
// proxy (qui, en Phase 2, résoudra via DoH). Étendre au fil des blocages.
export const PROXY_FORCED_HOSTS = ['uqload', 'voe.sx'];

export function isDirectable(streamUrl: string): boolean {
  let host: string;
  try { host = new URL(streamUrl).hostname; } catch { return false; }
  return !PROXY_FORCED_HOSTS.some(p => host.includes(p));
}

export function directDecision(streamUrl: string, forceLocal: boolean, proxy: string | undefined): boolean {
  return proxy === 'direct' && !forceLocal && isDirectable(streamUrl);
}
```
Puis dans `src/index.ts`, à côté de `buildProxyUrl`, ajouter `deliver()` (utilise `directDecision`) :
```ts
import { directDecision } from './deliver';
function deliver(streamUrl: string, headers: Record<string,string>,
  opts: { forceLocal?: boolean; forceHls?: boolean; useTransformer?: boolean },
  req: express.Request, config: UserConfig | null
): { url: string; proxyHeaders?: Record<string,string> } | null {
  if (directDecision(streamUrl, !!opts.forceLocal, config?.proxy)) {
    return { url: streamUrl, proxyHeaders: headers }; // brut, le client fetch
  }
  const url = buildProxyUrl(streamUrl, headers, opts.useTransformer ?? false, req, config,
                            opts.forceLocal ?? false, opts.forceHls ?? false);
  return url ? { url } : null;
}
```

- [ ] **Step 4 — vérifier le succès** : `npm test` → PASS.
- [ ] **Step 5 — build** : `npm run build` → OK.
- [ ] **Step 6 — commit** : `git add -A && git commit -m "feat(direct): helper deliver() + isDirectable/directDecision"`

---

### Task 3 : Brancher les 8 blocs sources sur `deliver()`

**Files:**
- Modify: `src/index.ts` (blocs movix ~826, streamflix ~897, wiflix ~921, voirdrama ~945, voiranime ~969, nabistream ~996, coflix ~1019, frenchstream ~1091)

**Interfaces consommées:** `deliver()` (Task 2).

Transformation **mécanique identique** par bloc : remplacer
`const proxiedUrl = buildProxyUrl(SRC.url, H, false, req, config[, false, forceHls]); if(!proxiedUrl) continue; ... url: proxiedUrl/finalUrl`
par :
```ts
const d = deliver(SRC.url, H, { forceHls: FH }, req, config);
if (!d) continue;
// dans drafts.push:
url: d.url,
behaviorHints: {
  notWebReady: !!d.proxyHeaders,
  bingeGroup: '<inchangé>',
  ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
},
```
où `FH` = `isHls` pour movix (le seul qui passe `forceHls`), sinon omis. `H` = les mêmes headers qu'aujourd'hui. Ne rien changer aux `_meta`.

- [ ] **Step 1** — movix (~838) : `deliver(mv.url, proxyHeaders, { forceHls: isHls }, req, config)`, draft avec `notWebReady:!!d.proxyHeaders` + `proxyHeaders` conditionnel. (Garder la branche `finalUrl = mv.url` du cas « déjà direct » — Purstream — telle quelle : elle pousse un draft SANS proxy déjà ; y appliquer aussi le spread proxyHeaders n'a pas lieu d'être car pas de headers. La laisser.)
- [ ] **Step 2** — streamflix (~897) : `deliver(sf.url, {Referer,Origin,UA}, {}, req, config)`.
- [ ] **Step 3** — wiflix (~921), voirdrama (~945), voiranime (~969), nabistream (~996), coflix (~1019) : idem (headers inline actuels).
- [ ] **Step 4** — frenchstream (~1091) : `deliver(fr.url, proxyHeaders, {}, req, config)`.
- [ ] **Step 5 — build** : `npm run build` → OK (tsc strict passe → signatures cohérentes).
- [ ] **Step 6 — commit** : `git add -A && git commit -m "feat(direct): livraison directe + proxyHeaders sur les 8 sources"`

---

### Task 4 : WebUI — option « Direct » dans `configure.html`

**Files:**
- Modify: `src/configure.html` (carte proxy ~277 ; `selectMode` ~390 ; `generateUrl` ~427 ; pré-remplissage ~535)

- [ ] **Step 1 — option HTML** : après le bloc `data-mode="local"` (avant `#local-warning`), insérer :
```html
<div class="option" data-mode="direct" onclick="selectMode('direct')">
    <h3><span>🚀</span> Direct — sans proxy <span class="badge">Self-host</span></h3>
    <p>Stremio lit directement depuis les CDN. Zéro bande passante serveur. NetMirror et quelques hôtes repassent par le proxy. Recommandé sur Stremio natif (le player web bute sur le CORS).</p>
</div>
```
- [ ] **Step 2 — generateUrl** : remplacer le `else { config.proxy = 'local'; }` par `else { config.proxy = currentMode; }` (currentMode vaut `'local'` ou `'direct'`). (mfUrl/mfPass restent absents hors mediaflow.)
- [ ] **Step 3 — pré-remplissage** (~535) : `if (config.proxy === 'local') selectMode('local'); else if (config.proxy === 'direct') selectMode('direct'); else selectMode('mediaflow');`
- [ ] **Step 4 — build** : `npm run build` (copie configure.html dans dist) → OK.
- [ ] **Step 5 — commit** : `git add -A && git commit -m "feat(direct): option 'Direct' dans configure.html"`

---

### Task 5 : Vérification manuelle bout-en-bout

- [ ] **Step 1** — déployer la branche : `docker compose up -d --build loostream` (ACCESS_KEY reste active).
- [ ] **Step 2** — forger un config direct (avec la clé d'accès) et requêter un stream Deadpool ; vérifier dans le JSON de réponse :
  - un stream **directable** (ex. wiflix/streamwish) a `url` = **URL CDN brute** (pas `/proxy`) + `behaviorHints.proxyHeaders.request` présent + `notWebReady:true`.
  - **NetMirror** a toujours `url` = `/netmirror/master.m3u8` (repli local), pas de proxyHeaders.
```bash
KEY=bdfee4fd8e76d29bc3563da2f9534ade
CFG=$(python3 -c "import base64,json,sys;print(base64.b64encode(json.dumps({'proxy':'direct','tmdbKey':'CLE_TMDB','accessKey':sys.argv[1]}).encode()).decode())" "$KEY")
curl -s "http://localhost:7002/$CFG/stream/movie/tt6263850.json" | python3 -m json.tool | grep -E "url|proxyHeaders|notWebReady" | head
```
- [ ] **Step 3** — (validation utilisateur) lecture réelle dans Stremio natif + confirmer `proxy=0` dans `/api/stats` après lecture d'un flux direct.

## Self-Review
- **Couverture spec** : `proxy:'direct'` (T1), deliver/proxyHeaders (T2-3), NetMirror repli (T2 `forceLocal`), MovieBox inchangé (non touché), WebUI (T4), PROXY_FORCED_HOSTS (T2). DoH = Phase 2 (hors plan). ✅
- **Placeholders** : aucun.
- **Cohérence types** : `deliver()` renvoie `{url, proxyHeaders?}` ; `directDecision`/`isDirectable` signatures fixées en T2 et réutilisées en T3.
- **Risque** : extraire `parseConfig` vers `config.ts` (T1) déplace du code — le build tsc strict garantit qu'aucune référence ne casse.

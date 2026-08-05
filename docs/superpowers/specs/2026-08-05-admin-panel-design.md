# Espace admin multi-pages — Design & Plan

**Goal:** Transformer l'admin single-page en un vrai espace : sidebar + 4 vues (Dashboard, Stats, Logs, Paramétrage), avec un flux de logs live et des réglages runtime éditables.

**Architecture:** Une seule page HTML autonome (`src/admin.html`, pas de build) avec sidebar + bascule de vues côté client. Auth inchangée (session cookie `ADMIN_USER`/`ADMIN_PASS`, `requireAdminSession`). Deux nouvelles pièces backend : un buffer de logs mémoire et un module de réglages runtime.

## Pages
- **Dashboard** : cartes santé des sources (🟢🟡🔴, `getAllMetrics`), KPIs (uptime, requêtes, streams servis, cache hit-rate), bouton health-check live.
- **Stats** : métriques détaillées par source (barres 20 slots), cache par scope, requêtes, streams servis.
- **Logs** : live tail depuis un buffer mémoire (~1000 lignes), filtres source + niveau + recherche, auto-refresh (poll `since`).
- **Paramétrage** (onglets) : Sources (endpoints, existant) · Whitelist (+ toggle AUTO_WHITELIST) · Partage (cases MODE + OWNER_KEY avec 🎲 générer).

## Backend

### 1. Buffer de logs — `src/logbuffer.ts`
- Ring borné (1000) de `{ seq, ts, level, source, msg }`. `level` ∈ info|warn|error déduit du contenu (`[X] Error`, `⚠`, `échoué`, `KO` → warn/error). `source` = tag `[Xxx]` en début de ligne.
- `installLogCapture()` : wrap `console.log`/`console.warn`/`console.error` — écrit dans le ring PUIS délègue à l'original (les logs Docker restent intacts). **Masque les secrets** : remplace toute occurrence d'`OWNER_KEY`/`ACCESS_KEY`/`api_password`/`&k=<val>` par `***`.
- `getLogs({ sinceSeq, source, level, q, limit })` → lignes filtrées + `lastSeq`.
- Appelé une fois au boot de `src/index.ts`.

### 2. Réglages runtime — `src/settings.ts` + `config/runtime-settings.json`
- Fichier `{ mode?: string, ownerKey?: string, autoWhitelist?: boolean }`. **Surcharge le `.env`** : si la clé est présente dans le fichier → elle gagne ; sinon fallback env. Chargé avec cache + invalidation à l'écriture.
- Getters : `getMode()` (→ remplace `process.env.MODE` dans `allowedModes`), `getOwnerKeyValue()` (→ remplace `process.env.OWNER_KEY` dans `access.ts`), `autoWhitelistEnabled()` (→ remplace le `const AUTO_WHITELIST` de `proxy.ts`).
- `updateSettings(patch)` : merge + écrit le fichier + invalide le cache. `settingsView()` : état pour l'admin (mode, ownerKey **masquée** en `configured:true/false` + longueur, autoWhitelist).

### 3. Endpoints (tous derrière `requireAdminSession` sauf lecture publique existante)
- `GET /api/logs?sinceSeq=&source=&level=&q=&limit=` → `{ lines, lastSeq, sources: [...] }`.
- `GET /api/settings` → `settingsView()`.
- `POST /api/settings` (admin) → `updateSettings(body)` (valide mode ∈ {DIRECT,MFP,LOCAL}, ownerKey string|null, autoWhitelist bool). Renvoie la vue à jour.
- Réutilise l'existant : `/api/stats`, `/api/cache/stats`, `/api/health`, `/api/*/endpoints`, `/api/whitelist`.

## Refactor requis (existant à toucher)
- `src/index.ts` : `allowedModes()` lit `getMode()` ; boot appelle `installLogCapture()` ; nouveaux endpoints ; `admin.html` réécrit.
- `src/access.ts` : `ownerKey()` lit `getOwnerKeyValue()` (fallback env).
- `src/proxy.ts` : `AUTO_WHITELIST` const → `autoWhitelistEnabled()` (fonction) là où il est utilisé (`buildManifestUrl` learn, `/api/whitelist` autoWhitelist flag).

## Sécurité
- Toutes les routes admin (settings POST, logs) derrière `requireAdminSession`.
- Buffer de logs : secrets masqués (`***`). `settingsView`/`/api/settings` ne renvoient jamais OWNER_KEY/ACCESS_KEY en clair (juste `configured` + longueur).
- Précédence claire : runtime-settings.json > .env > défaut.

## Plan d'implémentation (ordre)
1. `src/logbuffer.ts` + capture au boot + `GET /api/logs`.
2. `src/settings.ts` + `config/runtime-settings.json` + brancher getters (index/access/proxy) + `GET/POST /api/settings`.
3. Réécrire `src/admin.html` : sidebar + 4 vues (Dashboard, Stats, Logs, Paramétrage) + JS (fetch existants + logs poll + settings).
4. Build + test (endpoints répondent, capture logs OK, toggle AUTO_WHITELIST/MODE/OWNER_KEY appliqués à chaud) + vérif visuelle.

## Non-goals (YAGNI)
- Pas de graphes/historique long (juste les données actuelles bien présentées).
- Pas d'édition d'ACCESS_KEY (garde l'accès — reste .env only, affiché « activée » en lecture seule).
- Pas de socket Docker (buffer mémoire suffit).

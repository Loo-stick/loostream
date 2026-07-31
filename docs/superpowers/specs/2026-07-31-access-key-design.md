# Clé d'accès optionnelle — design

**Date :** 2026-07-31
**But :** empêcher que l'addon soit en libre accès (install + streaming + bande passante du proxy) pour un inconnu qui tomberait sur l'URL du host. Optionnel, activé par une variable `.env`.

## Décisions (validées)

- **Opt-in** : variable d'env `ACCESS_KEY`. Vide/absente → **aucun changement** (comportement actuel, libre accès). Renseignée → tout l'addon exige la clé.
- **La clé transite dans le CHEMIN, pas en query** — Stremio ne propage pas les query params de l'URL manifeste vers `/stream`,`/subtitles`. La clé est donc un champ du **config base64** (déjà dans le chemin).
- **Comparaison via `crypto.timingSafeEqual`** (anti-timing), avec pré-check de longueur pour éviter que timingSafeEqual jette sur des tailles différentes.
- **Hors périmètre** : `/configure` (il faut pouvoir générer l'URL) et `/api/*` (tapés par le bot Telegram sur le réseau Docker interne — les gater casserait le bot). Reco séparée : bloquer `/api/*` en externe côté Apache.

## Périmètre gaté (quand `ACCESS_KEY` est set)

| Surface | Mécanisme | Rejet |
|---|---|---|
| `/:config/manifest.json`, `/:config/stream/*`, `/:config/subtitles/*`, `/:config/configure` | `config.accessKey` doit == `ACCESS_KEY` | 401 |
| `/manifest.json`, `/stream/*` (sans config) | pas de clé possible | 401 |
| `/proxy/*` | query `?k=` doit == `ACCESS_KEY` | 403 |
| `/netmirror/*`, `/moviebox/stream`, `/nabistream/subtitle/*` | query `?k=` doit == `ACCESS_KEY` | 403 |

## Composants

### 1. Helper de comparaison (`src/access.ts`, nouveau)
- `accessEnabled(): boolean` → `!!process.env.ACCESS_KEY` (non vide).
- `keyMatches(candidate): boolean` → `false` si `candidate` n'est pas une string ou n'a pas la même longueur que `ACCESS_KEY` (évite que `timingSafeEqual` jette) ; sinon compare via `crypto.timingSafeEqual`. Les gardes appellent toujours `accessEnabled()` d'abord.
- Une seule source de vérité pour lire l'env + comparer. Testable unitairement (mock env).

### 2. Routes config (`src/index.ts`)
- `UserConfig` gagne `accessKey?: string`. `parseConfig` le lit/sanitize (comme `tmdbKey`, max 128).
- Nouveau garde `denyIfNoAccess(config, res): boolean` : si `accessEnabled()` et `!keyMatches(config?.accessKey)` → `res.status(401)`, renvoie `true` (l'appelant `return`). Appelé en tête de chaque route `/:config/*` **après** `parseConfig`.
- Routes sans config : si `accessEnabled()` → 401 direct (aucune clé possible).

### 3. Middleware query-key (`src/index.ts` + `src/proxy.ts`)
- Fonction `requireQueryKey(req,res,next)` : si `accessEnabled()` et `!keyMatches(req.query.k)` → 403 ; sinon `next()`.
- Montée sur `/moviebox`, `/nabistream`, `/netmirror` dans `index.ts`, et **en tête du router proxy** (`src/proxy.ts`, avant les routes) — `proxy.ts` lit `process.env.ACCESS_KEY` via le même helper.

### 4. Signature des URLs auto-générées
Ajouter `&k=<ACCESS_KEY>` **uniquement si `accessEnabled()`** dans :
- `buildProxyUrl` (branche proxy local → `/proxy/{manifest,stream,segment}`). La branche MediaFlow renvoie l'URL MediaFlow externe : pas de `k` (déjà couvert par le gate de la route stream).
- `nmProxy` (→ `/proxy/*`).
- Les URLs `/netmirror/master.m3u8` et `/netmirror/video.m3u8` générées (le master ET la référence interne vers video).
- L'URL `/moviebox/stream` (index.ts ~1029).
- L'URL `/nabistream/subtitle/*.vtt` (index.ts ~1183).

### 5. `configure.html`
- Nouveau champ « Clé d'accès (optionnel) » à côté de la clé TMDB.
- À la génération : si rempli → `config.accessKey = valeur`. Pré-remplissage au chargement d'un config existant (comme `tmdbKey`).
- Note UI : « à renseigner uniquement si l'hébergeur a activé une clé ».

## Flux

1. Le proprio met `ACCESS_KEY=<secret>` dans `.env`, redéploie.
2. Il colle le secret dans `configure.html` → URL d'install avec `accessKey` dans le config base64.
3. Stremio appelle `/:config/manifest.json` → garde OK → manifeste ; idem stream/subtitles.
4. Les URLs de flux renvoyées (proxy/netmirror/moviebox/nabistream) portent `&k=<secret>` → le player les rappelle → middleware OK.
5. Un inconnu sans clé : 401 sur manifest/stream (ne peut pas installer), 403 sur le proxy (ne peut pas cramer la bande passante).
6. Fuite → changer `ACCESS_KEY` invalide toutes les URLs d'un coup.

## Gestion d'erreurs / bords

- `timingSafeEqual` jette si longueurs différentes → `keyMatches` compare d'abord les longueurs (retourne `false` sans jeter). Candidat `undefined`/non-string → `false`.
- Config invalide (base64 pourri) → `parseConfig` renvoie `null` → 401 (pas de clé).
- Rétro-compat : `ACCESS_KEY` absente → helpers court-circuitent, zéro impact sur les installs existantes.

## Tests

- `src/access.test.ts` : `keyMatches` (bon/mauvais/longueurs ≠/undefined) avec env mockée ; `accessEnabled` set/unset. Pas de réseau.
- Vérif manuelle post-déploiement : sans `ACCESS_KEY` tout marche ; avec, une URL sans clé → 401, `/proxy?url=…` sans `k` → 403, une URL correcte → lecture OK.

## Non-objectifs

- Pas de multi-clés / clés par utilisateur / révocation individuelle (une seule clé partagée ; rotation = changer l'env).
- Pas de gating de `/api/*` ni `/configure` (voir reco Apache).
- Pas de rate-limit par clé (déjà un rate-limit IP global).

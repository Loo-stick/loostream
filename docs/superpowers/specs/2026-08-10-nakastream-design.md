# Intégration nakastream (source opt-in par utilisateur) — Design

**Date** : 2026-08-10
**Branche** : `feat/nakastream`
**Origine** : Stick veut ajouter nakastream.tv comme source. Compte requis → **opt-in par utilisateur via pairing par code**.

## Objectif

Ajouter **nakastream** comme source **optionnelle, activée par utilisateur** : celui qui le souhaite connecte son compte nakastream (email fictif possible) via un **code de pairing** collé dans le wizard configure. Sans code → source désactivée pour lui. nakastream apporte un catalogue **FR + anime** (~8289 titres) en **HLS direct tokené** (re-hébergé sur son R2), avec **sous-titres FR/EN (WebVTT)**.

**Contrainte workflow** : aucun `git push` sans l'aval explicite de Stick (cf. [[test-before-push]]). Travail sur `feat/nakastream`.

## Ce qui a été validé en LIVE (reverse fait le 2026-08-10)

- **Pairing** : `POST /api/v1/auth/pair/generate` exige la session nakastream (401 sans) → **le USER génère le code sur nakastream** (flux « connecter une TV »). `POST /api/v1/auth/pair/claim` body `{"code":"ABCDE"}` (sans auth) → renvoie `{user, token}` (token opaque `oat_…`, ~79 chars). Code **usage unique + expiration courte**.
- **Auth API** : `Authorization: Bearer <oat_token>` (durable, type token device).
- **Résolution** : `GET /api/v1/browse/by-tmdb/<tmdbId>/<mediaTypeInt>` (media_type = **entier**, à confirmer 1=film/2=série à l'implémentation ; repli `GET /api/v1/browse/search?q=<titre>`). Renvoie l'objet contenu (`id`, `tmdbId`, `mediaType`, `title`, `quality`, `audioLanguages`, `subtitleLanguages`…).
- **Flux** : `GET /api/v1/streaming/source/<contentId>` (+ `?season=&episode=` pour les séries) → `{ url, subtitles[], audioTracks[] }`.
  - `url` = `/api/v1/r2/<...>/master.m3u8?token=<t>&exp=<ts>` — **master HLS standard** (structure purstream-like : `#EXT-X-MEDIA:TYPE=AUDIO` FR **DEFAULT=YES** + EN, variante vidéo). **Jouable avec le seul `?token` (PAS de Bearer sur le manifeste/segments)** — vérifié 200 sans Authorization.
  - `subtitles[]` = `[{lang:"fre|eng", label, url:"…/subs_fre.vtt?token=…&exp=…", default, forced}]` — **WebVTT réels** (vérifié 63 Ko de cues FR), joignables avec le seul `?token`.
  - `audioTracks[]` = `[{lang:"fr",label,default:true},{lang:"en",…}]`.
- **Token du flux/subs = `exp` court** → doit être résolu **au moment de la requête stream** (frais), comme purstream/livavid.
- ⚠️ **DNS** : nakastream.tv a montré un `Could not resolve host` transitoire sur ce serveur (comme anime-sama) → prévoir un retry.

## Décisions cadrées (avec Stick)

- **Opt-in par utilisateur** : pas de token partagé. Chacun décide.
- **Pairing par code** collé dans le wizard, à l'**étape « Clés »**, avec un **bouton d'aide « i »** expliquant comment obtenir le code sur nakastream.
- **Token expiré/invalide (401)** → **entrée informative NON-bloquante** : on ajoute UN flux « ⚠️ nakastream déconnecté — reconnecte-le dans /configure » (externalUrl vers configure pré-rempli), **les autres sources continuent normalement** (contrairement au pseudo qui, lui, bloque tout).

---

## Partie 1 — Config + pairing

### 1.1 Config
`UserConfig.nakastreamToken?: string` — le token `oat_…` obtenu par claim. Inclus dans le base64 seulement si présent (rétro-compat). Sanitize : garder `^[A-Za-z0-9._-]{10,120}$`, sinon ignorer.

### 1.2 Endpoint de claim (serveur) — `POST /api/nakastream/claim`
- Body `{ code }`. Le serveur appelle `POST https://nakastream.tv/api/v1/auth/pair/claim {code}` → renvoie `{ ok:true, token }` ou `{ ok:false, error }` (code invalide/expiré).
- Fait côté serveur = **pas de CORS**. Timeout + retry DNS. Ne loggue jamais le token en clair (masqué par logbuffer de toute façon).

### 1.3 Configure (étape « Clés »)
- Champ « Code nakastream (optionnel) » + bouton **« i »** (popover) : « Va sur nakastream.tv (connecté), lance *Connecter une TV/appareil*, copie le code affiché et colle-le ici. Email fictif accepté. »
- Bouton **« Connecter »** : `POST /api/nakastream/claim {code}` → si ok, stocke le token (état interne) + affiche « ✅ Connecté ». À la génération du lien, `config.nakastreamToken = token`.
- Pré-remplissage : si le lien porte déjà un `nakastreamToken`, afficher « ✅ nakastream connecté » (+ bouton « Reconnecter » pour re-claim un nouveau code).

## Partie 2 — Scraper `src/scrapers/nakastream.ts` (NOUVEAU)

`getNakastreamStreams(token, tmdbId, mediaType, season?, episode?, title?)` → `NakaStream[]` (+ sous-titres). Actif **seulement si token présent**.
1. `browse/by-tmdb/<tmdbId>/<typeInt>` (repli `browse/search?q=<title>` + match TMDB) → `contentId` ou `null` (hors catalogue = normal, silencieux).
2. `streaming/source/<contentId>` (+ `?season=&episode=`) avec `Authorization: Bearer <token>`.
   - **401** → lève une erreur typée `NakastreamAuthError` (le handler ajoutera l'entrée « reconnecte »).
   - sinon → 1 flux : `url` = `https://nakastream.tv<master>` (absolu), `language:'MULTI'`, `quality` (depuis le contenu / la variante), `format:'m3u8'`, + `subtitles` (fr/eng VTT en absolu).
- Caché (TTL court, ex. 5 min — token `exp` court) via `cached`, scope `nakastream`.

## Partie 3 — Câblage (`src/index.ts`)

- Fan-out : ajouter `nakastream` à `SOURCE_NAMES` + la source, gatée `isSourceEnabled('nakastream') && !!config?.nakastreamToken`.
- Le résultat alimente les flux normaux (livraison via `deliver` — master directable avec `?token` ; repli proxy si Referer requis sur segments). Résolution **au stream-time** (token frais).
- **Sous-titres** : ajouter les pistes VTT nakastream à la ressource `/subtitles` de l'addon (cf. [[nuvio_subtitles_resource]]) — URLs tokenées absolues, livrées/proxifiées comme les autres subs.
- **Gestion 401** : si la source nakastream lève `NakastreamAuthError`, on **n'échoue pas la requête** ; on **ajoute une entrée informative** `{ name:'nakastream ⚠️', title:'nakastream déconnecté\nReconnecte-le dans la configuration.', externalUrl:'<base>/<config>/configure' }` en fin de liste. Non-bloquant.

## Partie 4 — Admin
- `nakastream` apparaît dans la vue Sources (metrics) comme les autres, activable/coupable.

## Sécurité & vie privée
- Le token nakastream est **par utilisateur**, dans SON base64 (comme les autres clés). Jamais partagé, jamais loggué en clair (masqué). Le claim se fait serveur-side.
- L'entrée « déconnecté » renvoie vers le configure de l'utilisateur (pré-rempli) — aucune donnée tierce.

## Fichiers touchés
- `src/index.ts` — `UserConfig.nakastreamToken` + sanitize `parseConfig`, endpoint `/api/nakastream/claim`, source dans le fan-out (+ SOURCE_NAMES), gestion 401 (entrée informative), sous-titres nakastream dans `/subtitles`.
- `src/scrapers/nakastream.ts` — **NOUVEAU** (résolution TMDB→content, source, subs, `NakastreamAuthError`).
- `src/configure.html` — champ code + bouton « i » + « Connecter » (claim) dans l'étape « Clés » ; pré-remplissage.
- (config) `nakastream-endpoints.json` optionnel si on veut hot-swap le domaine (nakastream.tv) — à décider (les autres scrapers ont ce pattern).

## Critères de succès
1. Un user colle un code valide dans configure → « ✅ Connecté » → son lien porte le token.
2. Pour un titre du catalogue nakastream, un flux nakastream (MULTI, FR audio par défaut) remonte + ses sous-titres FR/EN VTT.
3. Titre hors catalogue → silencieux (pas d'erreur).
4. Token expiré (401) → **entrée « reconnecte »** apparaît, les AUTRES sources restent normales.
5. Aucun user sans token n'est impacté (source simplement absente).
6. Le token n'apparaît jamais en clair dans les logs.

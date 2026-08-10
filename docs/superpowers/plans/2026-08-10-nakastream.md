# Intégration nakastream — Plan d'implémentation

> REQUIRED SUB-SKILL: superpowers:executing-plans. Étapes en `- [ ]`.

**Goal:** Ajouter nakastream comme source opt-in par utilisateur (pairing par code), avec sous-titres FR/EN.

**Architecture:** Nouveau scraper `src/scrapers/nakastream.ts` (search→match tmdb→streaming/source, Bearer token). Endpoint serveur `/api/nakastream/claim` pour le pairing. Champ `nakastreamToken` par user. Gestion 401 = entrée informative non-bloquante. Subs via la ressource `/subtitles`.

**Tech:** TS strict, axios, cache existant. Gabarit = `src/scrapers/nabistream.ts`.

## Global Constraints
- Aucun `git push` sans l'aval de Stick. Commits locaux OK. `npm run build` = vérif tsc.
- Ne jamais logguer le token en clair (logbuffer masque déjà, mais éviter les console.log du token).
- Rétro-compat base64 (champ absent = OK). Token per-user, jamais partagé.
- Résolution au **stream-time** (token `exp` court). Ne PAS utiliser `by-tmdb` (cassé) — `browse/search` + match `tmdbId`.
- Déployer pour que Stick teste ; ne rien pousser.

## Task 1 — Scraper `src/scrapers/nakastream.ts`
**Files:** Create `src/scrapers/nakastream.ts`
- [ ] `NakastreamStream { url; quality; language; server:'nakastream'; subtitles:{lang;url}[] }` + `class NakastreamAuthError extends Error`.
- [ ] `nk(token)` = axios instance, base `https://nakastream.tv/api/v1`, header `Authorization: Bearer <token>`, UA + Referer, timeout 12s, retry DNS (1 retry sur ENOTFOUND/EAI_AGAIN).
- [ ] `resolveContentId(token, tmdbId, title, mediaType)` : `GET /browse/search?q=<title>` → `data[].find(c => String(c.tmdbId)===String(tmdbId) && c.mediaType===(series?'tv':'movie'))` → `id` ou null.
- [ ] `getNakastreamStreams(token, tmdbId, mediaType, season?, episode?, title?)` : garde `if (!token || !tmdbId || !title) return []`. Cache `nakastream:${mode?}:${tmdbId}:${season||''}:${episode||''}` TTL 5 min (`shouldCache: r=>r.length>0`).
  - résout contentId (sinon `[]` silencieux),
  - `GET /streaming/source/<id>` (+ params season/episode si série) → `{url, subtitles, audioTracks}`,
  - **401** → `throw new NakastreamAuthError()`,
  - master absolu `https://nakastream.tv${url}` ; `language` = 'MULTI' si ≥2 audioTracks sinon 'VF'/'VOSTFR' ; `quality` via probe master (ou 'HD') ; subs = `subtitles.filter(url).map(s=>({lang: iso3(s.lang), url: 'https://nakastream.tv'+s.url}))`.
- [ ] `npm run build` OK.
- [ ] Test live (token dans /tmp/claim2.json) : script node ad-hoc → Dune 2 (tmdb 693134, title "Dune : Deuxième partie") renvoie 1 flux + 2 subs.
- [ ] Commit `feat(nakastream): scraper (search+match tmdb -> streaming/source + subs)`.

## Task 2 — Config + endpoint claim (`src/index.ts`)
- [ ] `UserConfig.nakastreamToken?: string` + sanitize dans `parseConfig` (`^[A-Za-z0-9._-]{10,120}$`, sinon undefined) + inclus dans le retour.
- [ ] `POST /api/nakastream/claim` (jsonBody) : body `{code}` → `POST nakastream.tv/api/v1/auth/pair/claim {code}` → `{ok:true, token}` (extrait `token`) ou `{ok:false, error:'Code invalide ou expiré'}`. Timeout + retry DNS. Ne loggue pas le token.
- [ ] `npm run build` OK. Test : `curl -XPOST /api/nakastream/claim -d '{code}'` (avec un code frais fourni par Stick au moment du test) → renvoie un token.
- [ ] Commit `feat(nakastream): champ config + endpoint /api/nakastream/claim`.

## Task 3 — Fan-out + 401 + sous-titres (`src/index.ts`)
- [ ] Import `getNakastreamStreams, NakastreamAuthError`. Ajouter `'nakastream'` à `SOURCE_NAMES` + une source dans le fan-out, gatée `isSourceEnabled('nakastream') && !!config?.nakastreamToken`, appelée avec `(config.nakastreamToken, info.tmdbId, type, parsed.season, parsed.episode, info.title)`. `.catch` : si `NakastreamAuthError` → poser un flag `nakastreamAuthFailed=true` et renvoyer `[]` ; sinon log + `[]`.
- [ ] Livraison : mapper les résultats nakastream en flux (comme les autres scrapers à `{url,quality,language,server,subtitles}`) → `deliver(url, {Referer:'https://nakastream.tv/'}, {forceHls:true}, …)`. Master directable (token) ; repli proxy si besoin.
- [ ] Après le fan-out : si `nakastreamAuthFailed`, **ajouter une entrée informative** en fin de `cleanStreams` : `{name:'nakastream ⚠️', title:'nakastream déconnecté\nReconnecte-le dans la configuration.', externalUrl: '<base>/<cfgParam>/configure'}`. Non-bloquant.
- [ ] `handleSubtitles` : ajouter un bloc nakastream (si `config?.nakastreamToken`) → re-résout via `getNakastreamStreams(...)`, pousse les subs `{id:'nakastream-<i>-<lang>', url: signUrl(proxied), lang}` (proxifier/​signer comme nabistream/moviebox).
- [ ] `npm run build` OK + déploiement + test bout-en-bout (config avec token → flux nakastream + subs sur Dune 2).
- [ ] Commit `feat(nakastream): fan-out + entree informative 401 + sous-titres`.

## Task 4 — Configure (pairing dans l'étape « Clés »)
**Files:** Modify `src/configure.html`
- [ ] Étape « Clés » (s3) : champ « Code nakastream (optionnel) » + bouton **« i »** (popover : how-to obtenir le code sur nakastream.tv, email fictif OK) + bouton **« Connecter »**.
- [ ] `connectNakastream()` : `POST /api/nakastream/claim {code}` → si ok, stocke `nakastreamToken` (var JS) + affiche « ✅ Connecté » ; sinon message d'erreur.
- [ ] `generateUrl()` : `if (nakastreamToken) config.nakastreamToken = nakastreamToken;`.
- [ ] `loadExistingConfig` : si `config.nakastreamToken` → afficher « ✅ nakastream connecté » (+ bouton reconnecter).
- [ ] `npm run build` + déploiement + test manuel (Stick colle un code → connecté → lien porte le token).
- [ ] Commit `feat(configure): pairing nakastream (code + i + connecter) dans l'etape Cles`.

## Vérification finale
- [ ] `npm run build` OK. Déployé. Stick teste : titre du catalogue → flux nakastream + subs FR/EN ; hors catalogue → silencieux ; token révoqué → entrée « reconnecte » sans casser les autres sources.
- [ ] STOP — rapport, attendre « push ».

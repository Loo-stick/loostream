# Refonte dashboard + système de pseudo + page configure — Design

**Date** : 2026-08-09
**Branche** : `feat/dashboard-refonte`
**Origine** : demande utilisateur (Wallace, via Discord) relayée par Stick — pouvoir identifier *qui* a un problème, moderniser le dashboard admin et la page configure (jugée « trop ancienne »).

## Objectif

Trois chantiers cohérents :
1. **Système de pseudo** — chaque utilisateur peut se donner un pseudo (optionnel) dans sa config ; il remonte dans les logs et le dashboard pour le support.
2. **Tracking Users persistant** — savoir qui a cherché quoi et qui a eu des résultats vides/erreurs, en survivant aux redémarrages, à l'échelle (l'addon est proposé « à tout le monde »).
3. **Refonte visuelle** — dashboard admin + page configure (assistant step-by-step), thème sombre moderne cohérent.

**Contrainte de workflow** : aucun `git push` sans l'aval explicite de Stick. Le travail vit sur cette branche pour qu'il teste avant tout merge/tag/release.

## Décisions cadrées (validées avec Stick)

- Pseudo **OBLIGATOIRE** (changé le 2026-08-09 — était optionnel). Sans pseudo, `handleStream` ne sert AUCUN flux : il renvoie une entrée informative (`externalUrl`) qui ouvre `/configure` (config pré-remplie) pour en ajouter un. `configure.html` bloque la génération du lien sans pseudo. `pseudoLabel` garde le fallback `(anonyme)` par défense, mais aucune requête sans pseudo n'atteint plus le tracking (bloquée avant).
- Persistance des données Users **sur disque, survit au restart**.
- Stockage en **SQLite** (table `user_activity`), **pas** un fichier JSON réécrit à chaque flush : upsert incrémental indexé + purge de rétention → scale à des milliers d'utilisateurs (cohérent avec `cache.db` existant, qui est content-keyed, partagé et auto-purgé).
- Direction visuelle laissée à l'initiative (thème sombre moderne) ; page configure en **assistant (wizard) 4 étapes**.
- **Un mockup visuel sera présenté et validé avant de brancher le vrai code** des pages.

## Portée / non-portée

**Dans la portée** : champ pseudo dans la config + configure.html ; tagging des logs ; module de tracking SQLite ; endpoint `/api/users` (admin) ; vue « Utilisateurs » ; restyle admin.html ; refonte configure.html en wizard.

**Hors portée** : authentification par utilisateur, comptes/mot de passe, quotas par utilisateur, changement du modèle de cache existant (il suffit — voir Analyse), bande passante/scaling proxy (dépend de l'hébergeur, hors de ce lot).

---

## Partie 1 — Système de pseudo

### 1.1 Config
Ajout d'un champ optionnel à `UserConfig` (`src/index.ts`) :

```ts
interface UserConfig {
  // …existant…
  pseudo?: string; // libellé libre saisi par l'utilisateur, pour le support (optionnel)
}
```

- Saisi dans configure.html (champ « Pseudo (optionnel) — pour le support »), embarqué dans le base64 comme le reste.
- **Sanitisation** dans `parseConfig()` : `trim`, longueur max **24**, on ne garde que `[\p{L}\p{N} _.\-]` (lettres/chiffres/espace/`_`/`.`/`-`), on retire les caractères de contrôle. Chaîne vide après nettoyage → traité comme absent.
- Fonction utilitaire : `pseudoLabel(config): string` → renvoie le pseudo nettoyé ou `'(anonyme)'`.

### 1.2 Logs
Le handler de stream tague sa ligne de titre avec le pseudo :

```
[Stream] 👤 Wallace · Title: His Dark Materials (2019)
[Stream] 👤 (anonyme) · Title: The Secret Lives of Mormon Wives (2024)
```

→ `grep "👤 Wallace"` ou `grep "Wallace"` dans les logs sort tout ce que cette personne a lancé. Aucun autre format de log n'est modifié.

---

## Partie 2 — Tracking Users persistant (SQLite)

### 2.1 Module `src/user-activity.ts` (NOUVEAU)
Réutilise `better-sqlite3` (déjà dépendance). Base dédiée `config/users.db` (bind-montée → survit au recreate ; séparée de `cache.db` pour ne pas mélanger durées de vie et purges).

**Schéma** :
```sql
CREATE TABLE IF NOT EXISTS user_activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pseudo     TEXT    NOT NULL,          -- pseudo nettoyé ou '(anonyme)'
  media_type TEXT,                      -- 'movie' | 'series'
  content_id TEXT,                      -- ex. 'tt14986406:2:1'
  title      TEXT,                      -- titre résolu (TMDB/Cinemeta)
  streams    INTEGER NOT NULL DEFAULT 0,-- nb de flux retournés (0 = problème potentiel)
  outcome    TEXT    NOT NULL,          -- 'ok' | 'empty' | 'error'
  detail     TEXT,                      -- résumé par source (JSON) — TOUJOURS présent
  log        TEXT,                      -- trace de logs brute de la requête — voir politique
  ts         INTEGER NOT NULL           -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_ua_pseudo ON user_activity(pseudo);
CREATE INDEX IF NOT EXISTS idx_ua_ts     ON user_activity(ts);
```

**Logs détaillés par utilisateur (exigence Stick)** — chaque requête stocke deux niveaux de détail :
1. `detail` (**toujours**) : résumé structuré par source, ex. `{"movix":{"streams":4},"moviebox":{"streams":1},"wiflix":{"note":"0 supporté"}}`. Léger, sert les pastilles du panneau détail.
2. `log` (**trace brute de la requête**) : les lignes de logs émises PENDANT cette requête (`[Movix] …`, `[Videasy] …`, `[Stream] No streams found`…), horodatées — exactement ce qu'on lit dans `docker logs`, mais **filtré à cette requête / cet utilisateur**.

**Capture de la trace** : un contexte par requête via `AsyncLocalStorage` (posé au début de `handleStream` avec `{pseudo, buffer:[]}`). Un logger léger (ou un wrap de `console.log`) pousse chaque ligne dans le `buffer` du contexte courant en plus de l'écrire sur stdout. En fin de requête, le buffer (cappé, ex. **8 Ko / ~200 lignes**) est stocké dans `log`.

**Politique de capture** (échelle + vie privée) :
- `log` capturé **systématiquement pour les requêtes à problème** (`empty`/`error`) — celles qu'on investigue.
- Pour les requêtes `ok` : `log` **non stocké par défaut** (seul `detail` l'est) → borne le volume à l'échelle. Un **toggle admin** `captureAllLogs` (dans Paramétrage) permet de tout capturer temporairement pour du debug.
- Rétention **30 j** (purge `setInterval`, comme le cache) → borne taille **et** sensibilité.

**API du module** :
- `recordUserActivity(pseudo, e: { mediaType, contentId, title, streams, outcome, detail, log })` — un `INSERT` append, indexé.
- `getUsersOverview()` — agrégation `GROUP BY pseudo` : `lastSeen`, `requests`, `empties`, `errors`, `recentProblems` (7 j). **Trié** problèmes récents en tête, puis `lastSeen` desc.
- `getUserRequests(pseudo, limit=20)` — dernières requêtes d'un pseudo avec `title/streams/outcome/detail/ts` (sans le `log`, léger).
- `getRequestLog(id)` — la trace `log` complète d'une requête (chargée à la demande, au clic).

### 2.2 Point d'accroche
Au **début** de `handleStream` (`src/index.ts`), on ouvre le contexte de capture :
```ts
runWithLogCapture(pseudoLabel(config), async () => { /* corps du handler */ });
```
En **fin** de requête (succès, `0 stream`, ou exception) :
```ts
recordUserActivity(pseudoLabel(config), {
  mediaType: type, contentId: id, title: info?.title ?? '?',
  streams: finalStreams.length,
  outcome: errored ? 'error' : (finalStreams.length > 0 ? 'ok' : 'empty'),
  detail: perSourceSummary,                       // {source:{streams|note|error}}
  log: (problème || captureAllLogs()) ? capturedLines() : null,
});
```
`perSourceSummary` se construit à partir des résultats déjà collectés du fan-out (on a déjà par source le nb de streams / l'état). La trace `log` vient du buffer `AsyncLocalStorage`.

### 2.3 Analyse de charge (réponse à « notre système suffit ? »)
- **Cache** (`cache.db`) : clé par **contenu** (`source:mode:type:id:s:e`), donc **partagé** entre utilisateurs → plus d'utilisateurs = meilleur taux de hit. Auto-purge des expirés (`purgeTimer`). 6,7 Mo actuellement, borné. **Suffisant, rien à changer.**
- **user_activity** : append indexé + rétention 30 j. À 10 000 requêtes/j → ~300 k lignes max, trivial pour SQLite indexé. Agrégation `GROUP BY pseudo` sur index. **Scale sans souci.**
- Optimisation possible (si un jour nécessaire) : table `user_summary` en upsert (totaux par pseudo) pour éviter le `GROUP BY` complet. **Non retenue pour v1** (YAGNI) — le `GROUP BY` indexé suffit largement.

---

## Partie 3 — Vue « 👥 Utilisateurs » + endpoint

### 3.1 Endpoints (`src/index.ts`, tous `requireAdminSession`)
- `GET /api/users` → `getUsersOverview()` (liste triée).
- `GET /api/users/:pseudo` → `getUserRequests(pseudo)` (20 dernières requêtes + `detail`, sans le `log`).
- `GET /api/users/request/:id` → `getRequestLog(id)` (la trace brute complète, chargée au clic).

### 3.2 Vue dashboard
Nouvelle entrée nav `👥 Utilisateurs` dans admin.html. Table :
- Colonnes : **Pseudo**, **Dernière activité** (relatif), **Requêtes**, **⚠️ Vides**, **❌ Erreurs**.
- **Tri** : problèmes récents (vides+erreurs 7 j) en tête → on voit direct qui galère.
- Clic sur une ligne → **panneau détail** avec ses **requêtes récentes** ; **chaque requête est dépliable** :
  - résumé **par source** (pastilles : `movix 4`, `videasy 2 écartés`, `moviebox ∅`…),
  - **trace de logs détaillée** de la requête (mono, horodatée) — chargée à la demande via `/api/users/request/:id`. C'est le « logs détaillés par utilisateur » demandé.
- `(anonyme)` apparaît comme une ligne agrégée normale.

---

## Partie 4 — Refonte visuelle

### 4.1 Direction (thème sombre moderne, cohérent dashboard ↔ configure)
- Palette sombre avec **une couleur d'accent** ; cartes, coins arrondis, ombres douces ; typo système lisible ; densité d'info maîtrisée. Tokens de couleur centralisés (variables CSS) réutilisés par les deux pages.
- **Un mockup (aperçu HTML) sera produit et validé par Stick avant de brancher le code réel.**

### 4.2 Dashboard (`src/admin.html`)
- Restyle des vues existantes (Dashboard / Sources / Stats / Paramétrage / Logs) + nouvelle vue **Utilisateurs**.
- Pas de changement fonctionnel des endpoints existants ; on refait la présentation (layout cartes, hiérarchie, états santé plus lisibles).

### 4.3 Page configure (`src/configure.html`) — assistant 5 étapes
1. **Hébergeur** — la **clé propriétaire EN PREMIER** (optionnelle). Elle débloque le mode « Proxy local » à l'étape suivante. Réutilise l'existant : `applyModes(ownerKey)` → `/api/modes?ownerKey=`. Explication sécurité : le local est **enforced serveur** (parseConfig downgrade si la clé est absente/fausse ; les endpoints `/proxy/*` exigent la clé d'accès) → un lien trafiqué n'ouvre pas le local.
2. **Mode** — MediaFlow / Direct toujours ; **« Proxy local » n'apparaît que si une clé propriétaire (valide) a été saisie** à l'étape 1.
3. **Clés** — TMDB, identifiants MediaFlow, clé d'accès (si l'hébergeur l'exige).
4. **Préférences** — **« Qualités à afficher »** (toggles 4K/1080p/720p/480p/360p : décocher = exclure, cf. §Exclusion qualité), qualité préférée (tri), ordre des langues, `minStreams`, tri (langue/qualité).
5. **Pseudo + génération** — champ pseudo (optionnel) + génération de l'URL d'install (copier / ouvrir dans Stremio).
- Indicateur de progression, validation par étape, **mêmes champs fonctionnels qu'aujourd'hui** (aucune régression) + pseudo + `excludeQualities`. Base64 rétro-compatible (champs simplement absents des anciennes URLs).

### 4.4 Exclusion de qualités (nouveau — `excludeQualities`)
Aujourd'hui la qualité **ne filtre pas**, elle ne sert qu'au tri (cf. `src/prefs.ts`, historique du sur-filtrage). On ajoute un **filtre d'exclusion explicite, opt-in** :
- Config : `excludeQualities?: string[]` (sous-ensemble de `4K/1080p/720p/480p/360p`), validé dans `parseConfig`, inclus dans le base64 seulement si non vide.
- `prefs.ts` : `passesPreferences(meta, langOrder, excludeQualities?)` — rejette un flux si `normalizeQuality(quality) ∈ excludeQualities`. **NetMirror reste exempté** (HLS multi-qualité). ⚠️ Le label générique « HD » normalise en 1080p — l'exclusion des extrêmes (4K/360p) est sûre ; documenter que « exclure 1080p » peut toucher des flux HD génériques.
- Le **fallback anti-vide** existant est conservé : si le filtrage (langue + qualité) ne laisse rien, on retombe sur tous les flux triés (mieux qu'un écran vide).
- Appliqué au **filtre final** (`filterAndSortStreams`) ET au **compteur d'early-exit** (même prédicat) pour rester cohérent.

---

## Sécurité & vie privée
- `user_activity` stocke **pseudos + titres cherchés** = données de visionnage. Accès **admin-only** (derrière la session admin), sur le serveur de l'hébergeur. Rétention **30 j** (purge auto) pour borner l'exposition.
- Le pseudo est **auto-déclaré** et optionnel ; base64 non chiffré (comme le reste de la config) → ne pas y mettre d'info sensible (mention dans le libellé du champ).
- Aucune donnée n'est envoyée à un tiers ; tout reste sur l'instance auto-hébergée.

## Fichiers touchés
- `src/index.ts` — `UserConfig.pseudo`, sanitisation dans `parseConfig`, `pseudoLabel()`, capture de logs par requête (`AsyncLocalStorage` : `runWithLogCapture`/`capturedLines`), tagging des logs, `recordUserActivity` dans `handleStream`, endpoints `/api/users`, `/api/users/:pseudo`, `/api/users/request/:id`.
- `src/user-activity.ts` — **NOUVEAU** module SQLite (schéma avec `detail`+`log`, record, overview, requests, `getRequestLog`, purge 30 j).
- `src/settings.ts` — toggle `captureAllLogs` (défaut off ; problèmes toujours capturés).
- `src/admin.html` — vue « Utilisateurs » (table + panneau requêtes dépliables + trace de logs) + restyle global + le toggle capture-all dans Paramétrage.
- `src/configure.html` — refonte en assistant 4 étapes + champ pseudo.

## Critères de succès
1. Un utilisateur qui met « Wallace » dans configure voit ses requêtes tagguées `👤 Wallace` dans les logs.
2. Le dashboard « Utilisateurs » liste les pseudos, met en tête ceux qui ont eu des vides/erreurs récents ; le détail montre leurs requêtes récentes, et **chaque requête se déplie sur sa trace de logs détaillée** (résumé par source + lignes brutes horodatées) — au moins pour les requêtes à problème.
3. Les données Users **survivent à un `docker compose up -d --build`** (restart/recreate).
4. Anciennes URLs d'install (sans pseudo) : toujours fonctionnelles, l'utilisateur apparaît en `(anonyme)`.
5. Dashboard et configure ont une identité visuelle moderne cohérente ; configure guide en 4 étapes.

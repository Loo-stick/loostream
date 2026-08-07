# Contrôle des sources — design

**Date :** 2026-08-07
**Objectif :** rendre le contrôle des sources clair et actionnable — tuer le bruit
des fausses alertes du bot, offrir une vue admin « Sources » lisible (santé + on/off),
et rendre les alertes Telegram nettes et actionnables.

Répartition validée avec Stick : **admin = centre de contrôle riche**, **bot = alertes
push clarifiées avec boutons rapides**.

---

## Partie 1 — Fix des fausses alertes (priorité, soulage tout de suite)

### Problème constaté
Le bot spamme des alertes fausses/trompeuses :
- `🟡 streamflix → WARNING · Fenêtre: 0✓ 20∅ 0⚠` — la source ne plante PAS, elle
  renvoie du **vide** (normal : tout n'est pas sur toutes les sources, surtout séries /
  faible trafic). Le vide déclenche à tort un WARNING.
- Flapping WARNING ↔ « récupère → OK » à chaque fois que la fenêtre se remplit/vide.
- Faux « récupère → OK » à `0✓ 1∅` au démarrage.

### Causes racines
1. **`src/metrics.ts`** : `status='warning'` sur `window >= WINDOW_SIZE && !lastSuccessAt`
   — se déclenche sur une fenêtre **tout-vide** (0 erreur). Contredit le principe
   « le vide n'est pas une faute » déjà écrit dans le fichier.
2. **`telegram-bot.js`** : `lastScraperMetricsStatus` seedé avec seulement 4 scrapers
   (+ `faklum`, mort). Pour tout scraper absent du seed, `prev = undefined` → au 1er
   poll, la branche « récupère → OK » se déclenche (car `undefined !== 'ok'`).

### Décision
- **`metrics.ts`** — le statut ne dépend QUE des erreurs, jamais du vide/succès manquant :
  - `down` : `consecutiveErrors >= 5` (inchangé — source clairement morte).
  - `warning` : `errors >= 3 && errorRate >= 0.25` sur la fenêtre (source qui **erreur**
    de façon répétée, sans être franchement morte).
  - `ok` : tout le reste, **y compris une fenêtre tout-vide** (la source marche, elle
    n'a juste rien pour les titres testés).
  - `statusReason` reformulé en conséquence (mentionne le nb d'erreurs, jamais le vide).
- **`telegram-bot.js`** — `prev = lastScraperMetricsStatus[scraper] || 'ok'` (tout
  inconnu = `ok`) ; retirer `faklum` ; garder l'anti-flap (persistance N cycles).

### Critère de succès
Sur une instance qui teste des séries/titres variés : **zéro alerte** tant qu'aucune
source n'**erreur** réellement. Une alerte n'arrive que sur `warning`/`down` liés aux
erreurs, et une seule fois par transition (pas de flap, pas de faux « récupère »).

---

## Partie 2 — Vue admin « Sources » (santé + on/off)

### Données (déjà dispo)
`getAllMetrics()` (metrics.ts) : par source, fenêtre 20, succès/vide/erreurs, dernière
erreur, dernier succès, statut. Manque : le **détail des 20 dernières** (pour la frise
`●○✕`) et l'état **activé/désactivé**.

### Backend — on/off par source (nouveau)
- Réglage persistant `disabledSources: string[]` dans `runtime-settings.json`
  (via `settings.ts`, appliqué à chaud comme mode/pool).
- Helper `isSourceEnabled(name)`. Dans le fan-out (`index.ts`, `sourcePromises`), une
  source désactivée → `Promise.resolve([])` (skippée, zéro latence, absente des résultats).
- Endpoints admin : `POST /api/settings { disabledSources }` (ou action dédiée
  `POST /api/sources/:name/toggle`). Appliqué à chaud.
- `metrics.ts` : exposer les 20 dernières entrées (outcome par requête) pour la frise —
  `getAllMetrics()` renvoie en plus `recent: Outcome[]`.

### UI — nouvelle vue « Sources »
Une ligne par source, **triée problèmes en premier** (down > warning > ok > off) :

```
 SOURCE        ÉTAT     20 DERNIÈRES            BILAN            DERNIÈRE         ON/OFF
 ● NetMirror   ✅ OK    ●●●●○●●●●●●●○●●●●●●●●   18 ok · 2 vide   ✓ il y a 2 min   [ ▮ ON ]
 ● Wiflix      🔴 DOWN  ●●✕✕✕✕✕✕✕✕✕✕✕✕✕✕✕✕✕✕   2 ok · 18 err    ✕ "502 dood"     [ ▮ ON ] ⏻ Couper
 ● VoirDrama   ✅ OK    ○○○○●○○○○○●○○○○○○○○○   2 ok · 18 vide   ✓ il y a 1 h     [ ▮ ON ]
 ● StreamFlix  ⚪ OFF   —                       (désactivée)      —                [ OFF   ]
```
- Légende : ● succès · ○ **vide (normal)** · ✕ erreur. Badge couleur (vert/orange/rouge/gris).
- Toggle **ON/OFF** par source ; bouton **⏻ Couper** direct sur les DOWN.
- Bandeau résumé : « X OK · Y en erreur · Z coupées ».
- Remplace le « Détail par source (20 dernières requêtes) » actuel, jugé illisible.

---

## Partie 3 — Bot : alertes clarifiées + actionnables

- **Alerte santé** (uniquement sur `warning`/`down` réels, après le fix Partie 1) :
  message net, ex. `🔴 Wiflix DOWN — 18 err/20, dernière : « 502 dood »`, + boutons
  inline **[🔇 Couper la source] [Ouvrir l'admin]**. Le bouton « Couper » appelle
  l'endpoint de toggle (Partie 2).
- **Alerte domaine** (non whitelisté) : reformatée claire, boutons Ajouter/Ignorer
  inchangés.
- Le bot poste dans le chat admin déjà configuré (`config/telegram.json`).

---

## Ordre de livraison
1. **Partie 1** (fix fausses alertes) — d'abord, petit, soulage immédiatement.
2. **Partie 2** (vue admin + on/off) — le gros du morceau.
3. **Partie 3** (bot actionnable) — s'appuie sur le toggle de la Partie 2.

## Hors périmètre
- Pas de refonte du système de stats global (`/api/stats`, dashboard) au-delà de la
  vue Sources.
- Pas de « couper 1h puis re-tester auto » (on/off simple pour l'instant ; à voir plus tard).

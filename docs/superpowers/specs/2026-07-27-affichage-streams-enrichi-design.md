# Affichage enrichi des streams (Stremio direct) — Design

Date : 2026-07-27
Statut : validé, prêt pour plan d'implémentation

## Problème

L'affichage des streams dans Stremio est pauvre. Chaque source construit son
`name`/`title` à la main (9 sites de `streams.push`), avec des formats qui
divergent légèrement. On veut un rendu riche « à la AIOStreams » (emojis,
résolution, langue, taille, codec, serveur, sous-titres) **quand LooStream est
ajouté directement dans Stremio**.

Contrainte dure : **ne rien casser de ce qu'on envoie à AIOStreams**. AIOStreams
parse `behaviorHints.filename` (nom scène) + lit `behaviorHints.videoSize`, puis
applique son propre template — il ignore/remplace nos `name`/`title`. Donc tout
le travail d'affichage porte sur `name`/`title` uniquement, et NE TOUCHE PAS
`filename` / `videoSize` / `bingeGroup`.

## Surface ciblée

**Stremio en direct** (décision utilisateur). Les emojis dans `name`/`title`
n'affectent pas le parsing PTT d'AIOStreams : les tokens bruts (`1080p`, `VF`,
`x265`) restent présents dans le `filename`, qu'AIOStreams lit en priorité.

## Architecture

Nouveau module **`src/display.ts`** (miroir de `src/filename.ts`), responsable
unique du formatage d'affichage. Une **seule passe centralisée** après le
fan-out — mutualisée avec la boucle qui pose déjà `behaviorHints.filename`
(index.ts ~ligne 1074) — remplit `s.name` et `s.title` à partir de `s._meta`.

Conséquence : chaque site de `streams.push` ne calcule plus son `name`/`title` ;
il se contente de remplir `_meta` + `url` + `behaviorHints` de base. On retire
les `name`/`title` par-source (déduplication = amélioration ciblée du code).

Frontières nettes :
- `display.ts` : pur, sans I/O, testable en isolation. Entrée = un `DisplayMeta`
  (+ `originalLanguage`), sortie = `{ name, title }`.
- `handleStream` : orchestration, inchangée sauf la passe centrale.

## Données : extension de `_meta` (interne, retiré avant envoi)

`StreamWithMeta._meta` passe de `{ quality, language, source, codec? }` à :

```ts
_meta: {
  quality: string;          // tag qualité brut (1080p / HD / 4K / …)
  language: string;         // VF / VOSTFR / VO / MULTI / VFF / …
  source: string;           // clé provider (voiranime, moviebox, …)
  codec?: string;           // MovieBox
  server?: string;          // hôte lecteur (vidmoly, sibnet, uqload, …)
  platform?: string;        // NetMirror (Netflix / Disney+ / Prime)
  sizeBytes?: number;       // MovieBox (et tout stream avec videoSize)
  subCount?: number;        // MovieBox (nb de sous-titres)
}
```

Chaque source remplit ce qu'elle connaît. La plupart : `quality`, `language`,
`server`. MovieBox ajoute `codec`, `sizeBytes`, `subCount`. NetMirror ajoute
`platform` (et reste exempté du filtre de langue, inchangé).

## Format de rendu

### `name` (2 lignes)

```
{emoji résolution} {résolution}
{Provider}
```

Badge résolution (`resolutionBadge(quality)`), mappé sur le tag qualité brut :

| Qualité | Rendu |
|---------|-------|
| 2160p / 4k | 💎 4K |
| 1440p | 🔷 1440p |
| 1080p | 🎬 1080p |
| 720p | 📺 720p |
| 576p | 📱 576p |
| 480p | 📱 480p |
| HD (ni résolution connue) | 📺 HD |
| SD | 📼 SD |
| autre / vide | 🎞️ {tag brut ou "?"} |

Ligne 2 = `providerLabel(source)` (réutilise `filename.ts`), suffixé de la
plateforme pour NetMirror : `NetMirror Netflix`.

### `title` (1-2 lignes ; chips ` · ` ; on saute ce qui manque)

- **Ligne 1** : `{langue}` [` · 🧬 {codec}`] [` · 📊 {taille}`]
- **Ligne 2** : [`▶️ {serveur}`] [` · 💬 {n} sous-titres`]

On n'émet une ligne que si elle a au moins un chip. Un stream sans serveur ni
sous-titres (ex. MovieBox) a une ligne 1 seule ; un stream sans codec/taille
(ex. VoirAnime) a `langue` en ligne 1 et `serveur` en ligne 2.

Chip langue (`languageChip(language, originalLanguage)`) :

| Langue | Rendu |
|--------|-------|
| MULTI | 🌍 MULTI |
| VOSTFR | 💬 VOSTFR |
| VF / VFF / VFQ / FRENCH | 🇫🇷 {tag} |
| VO / ORIGINAL | {drapeau langue d'origine} VO |
| autre | 🗣️ {tag} |

Drapeau langue d'origine (VO) mappé depuis `originalLanguage` (ISO 639-1) :
en→🇬🇧, ja→🇯🇵, ko→🇰🇷, zh→🇨🇳, es→🇪🇸, de→🇩🇪, it→🇮🇹, pt→🇵🇹, ru→🇷🇺,
hi→🇮🇳, th→🇹🇭, tr→🇹🇷, ar→🇸🇦, fr→🇫🇷 ; fallback 🌐.

Taille : octets → humain (`1.2 GB`, `640 MB`), même helper que l'admin.

### Exemples

| Source | name | title |
|--------|------|-------|
| MovieBox 4K | `💎 4K` / `MovieBox` | `🇫🇷 VF · 🧬 x265 · 📊 2.1 GB` / `💬 3 sous-titres` |
| VoirAnime | `🎬 1080p` / `VoirAnime` | `🇫🇷 VF · ▶️ vidmoly` |
| NetMirror | `🎬 1080p` / `NetMirror Netflix` | `🌍 MULTI` |
| Anime VO | `📺 720p` / `VoirAnime` | `🇯🇵 VO · ▶️ mailru` |

## Ce qui NE change PAS

- `behaviorHints.filename` (nom scène pour AIOStreams) — intact.
- `behaviorHints.videoSize` — intact (déjà posé pour MovieBox).
- `behaviorHints.bingeGroup`, `url`, `notWebReady` — intacts.
- `filterAndSortStreams` — lit `_meta.quality`/`_meta.language`, inchangés.
- Aucune modification des scrapers, sauf ajout des champs `_meta` déjà connus
  (server/platform/size/sub) qu'ils calculaient parfois déjà dans le title.

## API du module `src/display.ts`

```ts
export interface DisplayMeta {
  quality: string; language: string; source: string;
  codec?: string; server?: string; platform?: string;
  sizeBytes?: number; subCount?: number;
}
export function resolutionBadge(quality: string): string;       // "💎 4K"
export function languageChip(lang: string, orig?: string): string; // "🇫🇷 VF"
export function buildStreamName(m: DisplayMeta): string;         // 2 lignes
export function buildStreamTitle(m: DisplayMeta, orig?: string): string; // 1-2 lignes
```

## Tests / validation

Pas de suite de tests dans le repo (`tsc --strict` seul). Validation :
1. `npm run build` (type-check strict).
2. Test isolé de `display.ts` sur un jeu de `DisplayMeta` couvrant chaque source
   (riche = MovieBox, pauvre = VoirAnime, multi = NetMirror, VO = anime).
3. Déploiement + vérif visuelle d'un titre réel dans Stremio (name/title rendus).
4. Vérif non-régression AIOStreams : le `filename` d'un stream est identique
   avant/après (diff sur la sortie `/stream/...json`).

## Hors périmètre (YAGNI)

- Enrichir les données côté AIOStreams (filename/videoSize) — surface non retenue.
- Emoji par provider en ligne 2 — jugé bruyant, écarté.
- HDR / audio multi-pistes / bitrate — données non disponibles côté scrapers.

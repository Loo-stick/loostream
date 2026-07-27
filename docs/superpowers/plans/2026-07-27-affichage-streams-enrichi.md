# Affichage enrichi des streams — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Afficher des `name`/`title` riches (emojis résolution/langue/codec/taille/serveur/sous-titres) pour LooStream ajouté directement dans Stremio, sans toucher ce qu'AIOStreams parse.

**Architecture:** Nouveau module pur `src/display.ts` (formatage). Dans `handleStream`, on accumule des *drafts* de streams (sans `name`/`title`), puis une passe centralisée unique fabrique `name`/`title` depuis `_meta`. `behaviorHints.filename`/`videoSize`/`bingeGroup`/`url` restent intacts → AIOStreams non impacté.

**Tech Stack:** TypeScript strict (Node), Express hand-rolled. Pas de framework de test — validation = `npm run build` (tsc --strict) + scripts node jetables contre `dist/`.

## Global Constraints

- Ne JAMAIS modifier `behaviorHints.filename`, `behaviorHints.videoSize`, `behaviorHints.bingeGroup`, ni `url` d'un stream. Contrainte de non-régression AIOStreams.
- Le module `src/display.ts` est pur (aucun I/O, aucun accès réseau/fs).
- Émojis figés (validés utilisateur) : résolution 💎 4K / 🔷 1440p / 🎬 1080p / 📺 720p / 📱 480p / 📺 HD / 📼 SD ; langue 🇫🇷 VF / 💬 VOSTFR / 🌍 MULTI / {drapeau} VO ; codec 🧬 ; taille 📊 ; serveur ▶️ ; sous-titres 💬.
- Taille en **décimal** (÷1e9 = GB, ÷1e6 = MB) pour cohérence avec l'affichage MovieBox existant.
- `tsc --strict` doit passer à chaque commit (lancé par `npm run build`).

---

### Task 1 : Module `src/display.ts`

**Files:**
- Create: `src/display.ts`
- Verify (jetable): `/tmp/claude-1000/-projets-stremio-addon-loostream/30a9499c-a745-431e-b3f0-ad771c052441/scratchpad/display-verify.js`

**Interfaces:**
- Consumes: `providerLabel(source: string): string` depuis `./filename` (déjà exporté).
- Produces:
  - `interface DisplayMeta { quality: string; language: string; source: string; codec?: string; server?: string; platform?: string; sizeBytes?: number; subCount?: number; }`
  - `resolutionBadge(quality: string): string`
  - `languageChip(language: string, originalLanguage?: string): string`
  - `humanSize(bytes: number): string`
  - `buildStreamName(m: DisplayMeta): string`
  - `buildStreamTitle(m: DisplayMeta, originalLanguage?: string): string`

- [ ] **Step 1 : Écrire le module `src/display.ts`**

```ts
// Rendu d'affichage des streams pour Stremio EN DIRECT (name + description).
// N'affecte PAS behaviorHints.filename : AIOStreams parse le filename, pas ces
// champs. On garde donc ici toute la fantaisie (emojis, multi-lignes) sans
// risque de régression sur le parsing PTT côté meta-addons.

import { providerLabel } from './filename';

export interface DisplayMeta {
  quality: string;
  language: string;
  source: string;
  codec?: string;
  server?: string;
  platform?: string;
  sizeBytes?: number;
  subCount?: number;
}

// Tag qualité brut -> "emoji résolution". Beaucoup de sources FR ne renvoient
// que "HD" : on lui donne son propre badge plutôt qu'un faux 720p.
export function resolutionBadge(quality: string): string {
  const q = (quality || '').toLowerCase();
  if (q.includes('2160') || q.includes('4k')) return '💎 4K';
  if (q.includes('1440')) return '🔷 1440p';
  if (q.includes('1080')) return '🎬 1080p';
  if (q.includes('720')) return '📺 720p';
  if (q.includes('576')) return '📱 576p';
  if (q.includes('480')) return '📱 480p';
  if (q === 'hd') return '📺 HD';
  if (q === 'sd') return '📼 SD';
  return `🎞️ ${quality || '?'}`;
}

// Drapeau de la langue d'origine (cas "VO"), depuis TMDB originalLanguage.
const ORIGIN_FLAG: Record<string, string> = {
  en: '🇬🇧', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', es: '🇪🇸', de: '🇩🇪', it: '🇮🇹',
  pt: '🇵🇹', ru: '🇷🇺', hi: '🇮🇳', th: '🇹🇭', tr: '🇹🇷', ar: '🇸🇦', fr: '🇫🇷',
};

export function languageChip(language: string, originalLanguage?: string): string {
  const l = (language || '').toUpperCase();
  if (l.includes('MULTI')) return '🌍 MULTI';
  if (l.includes('VOSTFR')) return '💬 VOSTFR';
  if (l === 'VF' || l === 'VFF' || l === 'VFQ' || l.includes('FRENCH')) return `🇫🇷 ${language}`;
  if (l === 'VO' || l.includes('ORIGINAL')) {
    const flag = ORIGIN_FLAG[(originalLanguage || '').toLowerCase()] || '🌐';
    return `${flag} VO`;
  }
  return `🗣️ ${language}`;
}

// Octets -> taille humaine décimale ("2.10 GB", "640 MB").
export function humanSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function codecChip(codec?: string): string {
  const c = (codec || '').toLowerCase();
  if (c.includes('hevc') || c.includes('265')) return 'x265';
  if (c.includes('avc') || c.includes('264')) return 'x264';
  return '';
}

// name : 2 lignes -> "{badge résolution}\n{Provider[ Platform]}"
export function buildStreamName(m: DisplayMeta): string {
  const provider = providerLabel(m.source) + (m.platform ? ` ${m.platform}` : '');
  return `${resolutionBadge(m.quality)}\n${provider}`;
}

// title : 1-2 lignes de chips " · ". Ligne 1 = langue [· codec] [· taille].
// Ligne 2 = [serveur] [· n sous-titres]. On saute toute ligne vide.
export function buildStreamTitle(m: DisplayMeta, originalLanguage?: string): string {
  const line1 = [languageChip(m.language, originalLanguage)];
  const codec = codecChip(m.codec);
  if (codec) line1.push(`🧬 ${codec}`);
  const size = m.sizeBytes ? humanSize(m.sizeBytes) : '';
  if (size) line1.push(`📊 ${size}`);

  const line2: string[] = [];
  if (m.server) line2.push(`▶️ ${m.server}`);
  if (m.subCount && m.subCount > 0) line2.push(`💬 ${m.subCount} sous-titres`);

  return [line1.join(' · '), line2.join(' · ')].filter(Boolean).join('\n');
}
```

- [ ] **Step 2 : Écrire le script de vérification jetable**

Créer `scratchpad/display-verify.js` (chemin scratchpad complet ci-dessus) :

```js
const D = '/projets/stremio-addon-loostream/dist/display';
const { resolutionBadge, languageChip, humanSize, buildStreamName, buildStreamTitle } = require(D);
const cases = [
  ['res 1080p', resolutionBadge('1080p'), '🎬 1080p'],
  ['res HD',    resolutionBadge('HD'),    '📺 HD'],
  ['res 4k',    resolutionBadge('2160p'), '💎 4K'],
  ['lang VOSTFR', languageChip('VOSTFR'), '💬 VOSTFR'],
  ['lang VO ja',  languageChip('VO','ja'), '🇯🇵 VO'],
  ['lang VF',     languageChip('VF'),      '🇫🇷 VF'],
  ['size 2.1e9',  humanSize(2.1e9),        '2.10 GB'],
  ['name moviebox', buildStreamName({quality:'2160p',language:'VF',source:'moviebox'}), '💎 4K\nMovieBox'],
  ['name netmirror', buildStreamName({quality:'1080p',language:'VF',source:'netmirror',platform:'Netflix'}), '🎬 1080p\nNetMirror Netflix'],
  ['title rich', buildStreamTitle({quality:'2160p',language:'VF',source:'moviebox',codec:'hevc',sizeBytes:2.1e9,subCount:3}), '🇫🇷 VF · 🧬 x265 · 📊 2.10 GB\n💬 3 sous-titres'],
  ['title poor', buildStreamTitle({quality:'1080p',language:'VF',source:'voiranime',server:'vidmoly'}), '🇫🇷 VF\n▶️ vidmoly'],
  ['title netmirror', buildStreamTitle({quality:'1080p',language:'MULTI',source:'netmirror'}), '🌍 MULTI'],
];
let ok = 0;
for (const [label, got, want] of cases) {
  if (got === want) { ok++; }
  else { console.log(`FAIL ${label}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}
console.log(`${ok}/${cases.length} OK`);
process.exit(ok === cases.length ? 0 : 1);
```

- [ ] **Step 3 : Lancer la vérif — doit ÉCHOUER (module pas encore compilé)**

Run: `cd /projets/stremio-addon-loostream && node scratchpad-path/display-verify.js`
Expected: FAIL — `Cannot find module '.../dist/display'` (le module n'est pas encore build).

- [ ] **Step 4 : Compiler + relancer la vérif — doit PASSER**

Run: `cd /projets/stremio-addon-loostream && npm run build && node scratchpad-path/display-verify.js`
Expected: `12/12 OK`, exit 0.

- [ ] **Step 5 : Commit**

```bash
git add src/display.ts
git commit -m "feat(display): module de rendu name/title enrichi (emojis)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2 : Porter les champs d'affichage dans `_meta`

**Files:**
- Modify: `src/index.ts` — interface `StreamWithMeta._meta` (ligne ~128) + les 9 sites `streams.push` (lignes ~788–1058).

**Interfaces:**
- Consumes: rien de nouveau (données déjà présentes dans les résultats scrapers : `mv.server`, `r.platform`, `wf.server`, `vd.server`, `va.server`, `fr.server`, `mb.codec`, `mb.sizeBytes`, `mb.subLangs`).
- Produces: chaque stream porte désormais un `_meta` complet consommable par Task 3.

- [ ] **Step 1 : Étendre l'interface `_meta`**

Modifier `src/index.ts` ligne ~128 :

```ts
  _meta: {
    quality: string;
    language: string;
    source: string;
    codec?: string;
    server?: string;
    platform?: string;
    sizeBytes?: number;
    subCount?: number;
  };
```

- [ ] **Step 2 : Remplir les nouveaux champs `_meta` à chaque source**

Ajouter dans le `_meta` de chaque `streams.push` (ne PAS toucher `name`/`title`/`url`/`behaviorHints` à cette étape) :

- Movix (`_meta` ~797) : `server: mv.server,`
- NetMirror (`_meta` ~833) : `platform: r.platform,`
- StreamFlix (~859) : rien à ajouter.
- Wiflix (~884) : `server: wf.server,`
- VoirDrama (~909) : `server: vd.server,`
- VoirAnime (~934) : `server: va.server,`
- MovieBox (~981) : `sizeBytes: mb.sizeBytes,` et `subCount: (mb.subLangs || []).length,` (le `codec: mb.codec` existe déjà).
- Faklum (~1019) : rien à ajouter.
- FrenchStream (~1054) : `server: fr.server,`

Exemple pour VoirAnime :

```ts
        _meta: {
          quality: va.quality,
          language: va.language,
          source: 'voiranime',
          server: va.server,
        },
```

- [ ] **Step 3 : Compiler — doit PASSER (ajout additif, zéro changement de comportement)**

Run: `cd /projets/stremio-addon-loostream && npm run build`
Expected: build OK, aucune erreur de type.

- [ ] **Step 4 : Commit**

```bash
git add src/index.ts
git commit -m "refactor(streams): porter server/platform/size/subCount dans _meta

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3 : Passe centralisée name/title (drafts) + branchement

**Files:**
- Modify: `src/index.ts` — import (~ligne 20), accumulateur de streams (~764), les 9 `streams.push` (retrait `name`/`title`), garde vide (~1061), construction finale `streams` (~1064).

**Interfaces:**
- Consumes: `buildStreamName`, `buildStreamTitle` depuis `./display` ; `StreamWithMeta` complet de Task 2.
- Produces: sortie visible identique en structure (mêmes clés `name`/`title`), seul le contenu textuel change. `behaviorHints.filename` inchangé.

- [ ] **Step 1 : Importer le module display**

`src/index.ts` ligne ~20, après l'import de `./filename` :

```ts
import { buildStreamName, buildStreamTitle } from './display';
```

- [ ] **Step 2 : Introduire le type draft + renommer l'accumulateur**

Remplacer `src/index.ts` ~ligne 764 `const streams: StreamWithMeta[] = [];` par :

```ts
    // On accumule des "drafts" (streams sans name/title). name/title sont posés
    // en UNE passe centralisée plus bas (src/display.ts), pour un rendu uniforme.
    type StreamDraft = Omit<StreamWithMeta, 'name' | 'title'>;
    const drafts: StreamDraft[] = [];
```

- [ ] **Step 3 : Basculer les 9 push sur `drafts` sans `name`/`title`**

Dans chaque `streams.push({ ... })` des 9 sources : remplacer `streams.push(` par `drafts.push(` et SUPPRIMER les deux lignes `name: ...,` et `title: ...,` du littéral. Conserver `url`, `behaviorHints`, `subtitles` (MovieBox), `_meta`.

Exemple (VoirAnime) — avant :

```ts
      streams.push({
        name: `VoirAnime\n${va.quality}`,
        title: `${va.language} [${va.quality}] • ${va.server}`,
        url: proxiedUrl,
        behaviorHints: { notWebReady: false, bingeGroup: `voiranime-${va.server}` },
        _meta: { quality: va.quality, language: va.language, source: 'voiranime', server: va.server },
      });
```

après :

```ts
      drafts.push({
        url: proxiedUrl,
        behaviorHints: { notWebReady: false, bingeGroup: `voiranime-${va.server}` },
        _meta: { quality: va.quality, language: va.language, source: 'voiranime', server: va.server },
      });
```

Pour Movix : la variable locale `serverLabel` (~787) n'est plus utilisée → la supprimer aussi. Pour MovieBox : les variables `codec`, `gb`, `extras`, `subCount` (~955–958) servaient à composer le title ; `subCount` reste utilisé par `_meta` (Task 2) mais `codec`/`gb`/`extras` ne servent plus → les supprimer.

- [ ] **Step 4 : Adapter la garde "aucun stream" et construire `streams` via la passe centrale**

Remplacer `src/index.ts` ~ligne 1061 :

```ts
    if (streams.length === 0) {
      console.log('[Stream] No streams found');
      return res.json({ streams: [] });
    }
```

par :

```ts
    if (drafts.length === 0) {
      console.log('[Stream] No streams found');
      return res.json({ streams: [] });
    }

    // Passe centralisée : name/title enrichis depuis _meta (src/display.ts).
    // originalLanguage résout le cas "VO" (drapeau de la langue d'origine).
    const streams: StreamWithMeta[] = drafts.map(d => ({
      ...d,
      name: buildStreamName(d._meta),
      title: buildStreamTitle(d._meta, info.originalLanguage),
    }));
```

Le reste de la fonction (passe `behaviorHints.filename` ~1074, `filterAndSortStreams(streams)`, comptages `streams.filter(...)`) référence `streams` et reste **inchangé**.

- [ ] **Step 5 : Compiler — doit PASSER**

Run: `cd /projets/stremio-addon-loostream && npm run build`
Expected: build OK. Si erreur "Cannot find name 'streams'" avant la construction → un `push` a été oublié en `streams.push` au lieu de `drafts.push`.

- [ ] **Step 6 : Vérif non-régression `filename` (bloc AIOStreams intact)**

Run: `cd /projets/stremio-addon-loostream && grep -n "s.behaviorHints.filename = buildFilename" src/index.ts`
Expected: la ligne existe toujours, inchangée. Confirme qu'on n'a pas touché la passe filename.

Run: `git diff -U0 src/index.ts | grep -E '^\+' | grep -iE 'filename|videoSize|bingeGroup' || echo "aucune modif filename/videoSize/bingeGroup"`
Expected: `aucune modif filename/videoSize/bingeGroup`.

- [ ] **Step 7 : Déployer + vérif visuelle**

Run: `cd /projets/stremio-addon-loostream && docker compose up -d --build loostream`
Puis l'utilisateur ouvre un titre réel dans Stremio (ex. un anime → VoirAnime, un film sur MovieBox) et vérifie :
- name sur 2 lignes avec emoji résolution + provider.
- title avec langue + (codec/taille si MovieBox) + serveur.

- [ ] **Step 8 : Commit**

```bash
git add src/index.ts
git commit -m "feat(display): passe centralisée name/title enrichis (Stremio direct)

Drafts sans name/title -> une passe unique via src/display.ts. filename,
videoSize et bingeGroup intacts (AIOStreams non impacté).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage :**
- Module `src/display.ts` (spec §Architecture, §API) → Task 1. ✓
- Extension `_meta` (spec §Données) → Task 2. ✓
- Passe centralisée + retrait name/title par-source (spec §Architecture) → Task 3. ✓
- Format name/title + emojis (spec §Format) → Task 1 (logique) + Task 3 (branchement). ✓
- Non-régression filename/videoSize/bingeGroup (spec §Ce qui ne change pas) → Task 3 Step 6. ✓
- Validation build + isolé + visuel (spec §Tests) → Task 1 Step 4, Task 3 Steps 5-7. ✓

**Placeholder scan :** aucun TBD/TODO ; tout le code des étapes est concret.

**Type consistency :** `DisplayMeta` (Task 1) ⊇ `StreamWithMeta._meta` (Task 2) — champs identiques (quality, language, source, codec?, server?, platform?, sizeBytes?, subCount?). `buildStreamName(m)` / `buildStreamTitle(m, orig)` signatures cohérentes entre Task 1 et Task 3. `StreamDraft = Omit<StreamWithMeta,'name'|'title'>` conserve `subtitles?` (MovieBox) et `_meta`. ✓

## Notes d'exécution

- « scratchpad-path » = `/tmp/claude-1000/-projets-stremio-addon-loostream/30a9499c-a745-431e-b3f0-ad771c052441/scratchpad`.
- Pas de suite de tests dans le repo : la « vérif » = script node jetable + `tsc --strict`. Le script `display-verify.js` n'est pas commité (jetable).
- Contrainte utilisateur en vigueur : ne pas commit/tag/push la partie déployée tant que l'utilisateur n'a pas validé le rendu visuel (Task 3 Step 7 avant Step 8).

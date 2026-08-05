# Source AnimeSama — Design & Plan

**Goal:** Ajouter AnimeSama (anime-sama.to) comme source — le plus gros trou de catalogue (anime VOSTFR/VF), en réutilisant le matcher de titre strict et nos extracteurs.

**Contexte (exploration Onyx + site live) :**
- Base **rotative** : `anime-sama.fr` (mort/bloqué depuis le serveur), **`anime-sama.to`** ✅ et `anime-sama.pw` ✅ (Cloudflare mais sert le vrai contenu, pas de challenge).
- **Recherche** : `POST /template-php/defaut/fetch.php` (`query=`) → items `<a href=".../catalogue/{slug}/">` + `<h3 class="asn-search-result-title">{Titre}</h3>`. Résultats **fuzzy** → le matcher tranche.
- **Saisons** : la fiche `/catalogue/{slug}/` liste des `panneauAnime("Saison 2", "saison2/vostfr")`, `"film/vostfr"`… (path = `saison{N}/{lang}` ou `film/{lang}`).
- **Épisodes** : `GET /catalogue/{slug}/{seasonPath}/{lang}/episodes.js` → `var eps1 = ['url', …]; var eps2 = […];` — **1 tableau par lecteur**, **index = épisode−1**.
- **Lecteurs** (mesuré) : `video.sibnet.ru` (✅ `extractSibnet` existant), `ansembed.net` (jwplayer, `.m3u8` en clair — extracteur simple à ajouter), + `sendvid.com` / `Smoothpre.com` (miroirs de secours, non requis en v1).

## Architecture

Module `src/scrapers/animesama.ts` (comme les autres scrapers) + un nouvel extracteur `ansembed`. **Gaté sur l'anime** (`originalLanguage === 'ja'`, comme VoirAnime) pour ne pas chercher chaque titre occidental. VOSTFR **et** VF.

## Extracteur `ansembed` (`src/extractors/index.ts`)
- Host map `ansembed: ['ansembed.net']`, `case 'ansembed'` → fetch la page embed (UA + Referer anime-sama), `findStreamUrl` (déjà : `file:`/`sources:` → `.m3u8`). Renvoie `{ url, quality:'HD', format:'hls', headers:{ Referer: 'https://ansembed.net/' } }`. Le CDN (`vmpx.online`…) tourne → appris par AUTO_WHITELIST à l'extraction.

## Module `src/scrapers/animesama.ts`
```ts
export function getAnimeSamaStreams(
  mediaType: 'movie' | 'series', titles: string[], season: number | undefined,
  episode: number | undefined, extractorConfig: ExtractorConfig,
): Promise<AnimeSamaStream[]>
```
1. **Recherche** : pour chaque titre, `POST fetch.php` → items `{slug, title}`. **Choix via `matching.pickBest`/`accepts`** (titre token-set ; pas d'année dispo → titre strict). Renvoie le slug retenu.
2. **Chemin saison** : série → `saison{season}` ; film → `film`. (Assumé : mapping direct TMDB→AnimeSama ; imparfait sur les très longs animes — itérer.)
3. **Langues** : pour `lang ∈ [vostfr, vf]`, `GET .../{seasonPath}/{lang}/episodes.js` (200 = existe). Parse `var eps\w+ = [ … ]` → tableaux de lecteurs.
4. **Épisode** : index `episode−1` (film → index 0). Collecte l'URL de chaque tableau-lecteur.
5. **Extraction** : `detectExtractor` + `extractStream` sur chaque URL, **ansembed & sibnet prioritaires**, 1ʳᵉ qui réussit → stream. (sendvid/Smoothpre ignorés en v1 — 2 miroirs solides suffisent.)
6. Retour `AnimeSamaStream[]` : `{ name:'AnimeSama', url, quality, language: lang==='vf'?'VF':'VOSTFR', headers }`, passé dans `applyMultiAudio` (qualité réelle).

Config `config/animesama-endpoints.json` `{ base:'https://anime-sama.to' }` (hot-reload, endpoint-config).

## Câblage `src/index.ts`
- Fan-out : 12ᵉ source, **gatée** `info.originalLanguage === 'ja'` (comme VoirAnime), keyée titres FR+original.
- `SOURCE_NAMES += 'animesama'`, `collected[11]`, bloc de livraison (HLS ansembed → proxy/direct selon mode ; mp4 sibnet), types stats/metrics += `animesama`.
- Endpoints admin `/api/animesama/endpoints` (+ reload) comme les autres sources à base unique.

## Non-goals (YAGNI)
- Pas de sendvid/Smoothpre en v1 (miroirs de secours ; sibnet+ansembed suffisent).
- Pas de mapping saison parfait pour les longs animes (One Piece) — `saison{N}` direct, on itère si besoin.
- Pas de catalogue/home (juste résolution stream, comme les autres scrapers).
- Anime uniquement (gaté `ja`) — pas de recherche sur les films occidentaux.

## Plan
1. Extracteur `ansembed` + test (findStreamUrl sur une page jwplayer).
2. Module `animesama.ts` (search+match, seasonPath, parse episodes.js, extract) + config + test du parseur `episodes.js` (pur).
3. Câblage index (fan-out gaté ja, delivery, metrics/stats, endpoint admin).
4. Build + vérif réelle (un anime standard : Jujutsu Kaisen S2E1 VOSTFR → stream jouable) + déploiement.

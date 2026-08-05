# Sous-titres FR externes (OpenSubtitles) pour les sources VO — Design & Plan

**Goal:** Fournir des sous-titres **FR** aux flux VO (Videasy et toute source VO) via la ressource `/subtitles` de Stremio, en les tirant d'OpenSubtitles. Aujourd'hui Videasy = VO anglais et son API ne porte quasi jamais de FR (vérifié : Deadpool & Wolverine → chi/eng/spa, pas de FR).

**Contexte (exploration) :**
- L'infra `/subtitles` existe déjà : manifest `resources:['subtitles']`, `handleSubtitles()` qui agrège nabistream/moviebox/videasy, endpoints `/X/subtitle` servant `text/vtt`, conversion SRT→VTT inline (pattern MovieBox).
- **API legacy `rest.opensubtitles.org` = sans clé, sans quota** (vérifié : `GET /search/imdbid-6263850/sublanguageid-fre` → 13 sous-titres FR, `SubDownloadLink` directs, `SubDownloadsCnt` pour le tri). Les liens `dl.opensubtitles.org/.../filead/1` renvoient du **SRT gzippé**.
- L'API v1 (`api.opensubtitles.com`) exige clé + login + quota bas → écartée.

## Architecture

Un module **`src/subtitles.ts`** (fetch OpenSubtitles legacy, caché) + un endpoint proxy **`/extsub/subtitle`** (gunzip + SRT→VTT + garde SSRF) + un bloc dans **`handleSubtitles`** qui ajoute les pistes FR. Aucune clé, aucune config.

## Module `src/subtitles.ts`

```ts
export interface ExtSub { url: string; name: string; downloads: number }
export function getFrenchSubtitles(imdbId: string, season?: number, episode?: number): Promise<ExtSub[]>;
```
- Base `https://rest.opensubtitles.org`, `User-Agent` descriptif (requis).
- Chemin : film → `/search/imdbid-{num}/sublanguageid-fre` ; série → `/search/episode-{ep}/imdbid-{num}/season-{s}/sublanguageid-fre`. `num` = imdbId sans `tt`.
- Filtre `SubFormat=srt` + `SubDownloadLink` ; **top 3 par `SubDownloadsCnt`** (les plus populaires = mieux synchronisés).
- Caché ~12 h (`scope:'extsub'`, `shouldCache: r=>r.length>0`).

## Endpoint `/extsub/subtitle?url=<SubDownloadLink>`

- **Garde SSRF** : `https` + hostname `∈ *.opensubtitles.org` (allowlist d'hôte tighte — suffit, pas besoin de l'allowlist générale).
- Fetch `arraybuffer` → si magic gzip `0x1f8b` → `zlib.gunzipSync` → sinon brut.
- Décode `utf-8` → **SRT→VTT** (mêmes remplacements que MovieBox : `,`→`.` sur les timings, normalisation `-->`). Préfixe `WEBVTT`.
- `Content-Type: text/vtt; charset=utf-8`, `Cache-Control: public, max-age=86400`.
- Erreur/hors-domaine → 403/502 (jamais throw).

## Câblage dans `handleSubtitles`

Après le bloc Videasy, si `info.imdbId` :
```ts
const ext = await getFrenchSubtitles(info.imdbId, type === 'series' ? parsed.season : undefined, type === 'series' ? parsed.episode : undefined);
ext.forEach((s, i) => {
  const su = new URL('/extsub/subtitle', baseUrl);
  su.searchParams.set('url', s.url);
  subtitles.push({ id: `opensubtitles-fr-${i}`, url: signUrl(su).toString(), lang: 'fre' });
});
```
Toujours proposés (utiles pour n'importe quel flux VO ; ignorés sur du VF). Libellé lang `fre` (ISO 639-2, cohérent avec l'existant).

## Non-goals (YAGNI)
- FR uniquement (pas d'autres langues — l'existant couvre déjà eng via les sources).
- Pas de gestion fine de charset (utf-8 ; certains subs latin1 pourront avoir des accents cassés — à raffiner si ça pose problème, via `SubEncoding`).
- Pas de clé/config (l'API legacy est libre).
- Pas de filtrage « seulement si un flux VO existe » : `/subtitles` ne connaît pas les flux choisis ; on propose toujours.

## Plan
1. `src/subtitles.ts` + `src/subtitles.test.ts` (parse de la réponse OpenSubtitles + tri + top-3). TDD (fixture JSON).
2. Endpoint `/extsub/subtitle` (gunzip + SRT→VTT + SSRF).
3. Câblage `handleSubtitles`.
4. Build + vérif réelle (Deadpool & Wolverine → pistes « fre » servies en VTT) + déploiement.

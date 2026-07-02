# CinemaOS scraper — design

Date: 2026-07-02

## Goal

Add **cinemaos.live** as a source to fill the gap on **recent / VO / Prime-Video** titles
that Movix, FrenchStream, Faklum, StreamFlix and NetMirror miss (e.g. "The Sheep
Detectives", Prime 2026 — currently unavailable anywhere in LooStream). CinemaOS is a
TMDB-keyed meta-aggregator over ~20 upstream providers; it has no unique content but its
aggregation is broad, multi-language, and **includes subtitles**.

Validated end-to-end during the spike: the protocol below is fully reproducible
server-side (no Cloudflare block, no headless browser), returns direct HLS `m3u8`
sources, and resolves both a catalog title (Endgame) and the gap title (Sheep Detectives)
across 6+ scrapers.

## Cracked protocol (all client-side, keys hardcoded in cinemaos JS)

Endpoint: `GET https://cinemaos.live/api/providerv4/scrape?<params>`

Query params: `type` (`movie|tv`), `tmdbId`, `imdbId`, `t` (title), `ry` (release year),
`season` + `episode` (tv only), `secret`, `_gt`, `scraper` (one provider id per call).

Also send header `x-c4os-auth: <_gt>`.

### `secret` — double HMAC-SHA256 (module 18310 `generateContentHash`)

```
PRIMARY   = "a7f3b9c2e8d4f1a6b5c9e2d7f4a8b3c6e1d9f7a4b2c8e5d3f9a6b4c1e7d2f8a5"
SECONDARY = "d3f8a5b2c9e6d1f7a4b8c5e2d9f3a6b1c7e4d8f2a9b5c3e7d4f1a8b6c2e9d5f3"
canonical = ["tmdbId:"+tmdbId, "imdbId:"+imdbId, "seasonId:"+season, "episodeId:"+episode]
            .filter(non-empty).join("|")
r      = HMAC_SHA256(PRIMARY,   canonical).hex()
secret = HMAC_SHA256(SECONDARY, r).hex()
```
Confirmed byte-identical to the browser's value for Endgame.

### `_gt` — static token

`_gt = "2549b22d9bf0d91847a2811baac98d0079e02dba592aea94"` (also the `x-c4os-auth` header).

### Response decryption (module 91712 `decryptData`)

Response: `{ data: { encrypted, cin, mao, salt? , version?, useKeyDerivation? }, encrypted: true }`.
Decrypt `data` with **AES-256-GCM**:
```
ENC_KEY = "a1b2c3d4e4f6477658455678901477567890abcdef1234567890abcdef123456"  (hex string)
iv   = hex(cin)   (16 bytes)
tag  = hex(mao)   (16 bytes)
salt = hex(salt)  if present, else sha256(iv).slice(0,32)
key  = (useKeyDerivation === false || (version!=null && version<1))
         ? Buffer.from(ENC_KEY,'hex')
         : pbkdf2Sync(ENC_KEY /* the hex STRING, utf8 */, salt, 100000, 32, 'sha256')
plain = JSON.parse( aes-256-gcm.decrypt(key, iv, tag, hex(encrypted)) )
```
`plain = { name, sources: { <ServerName>: {url, type:'hls', headers?, language?, bitrate?} }, captions: [{languageName, language, url}] }`.

## Scrapers

Client id → name (server validates the id; unknown ids return `{"error":"Unknown scraper"}` → skip):
`n3` Vidzee, `z2` Rive, `s7` Vidrock, `l5` Lordflix, `f8` Castle, `h0` Xpass,
`b5` Videasy, `k9` Icefy, `q4` Multimovies, `p6` Peachify, `v2` VidlinkPro,
`s3` Screenscape, `m4` NetMirror, `r8` Rezka, `zx` Zxcstream, `vc` Vidcore, `j1` Pkaystream.

**Curated default set** (queried in parallel, concurrency-capped): the ones that resolved
reliably in the spike — `n3, z2, s7, l5, f8, h0, b5, q4`. Configurable. A scraper returning
empty `sources` or `Unknown scraper` is skipped silently.

## Source extraction

For each decrypted `sources` entry:
- `type: 'hls'` → an HLS `m3u8` stream. Attach `headers` (Referer/UA) for the proxy.
- **Worker-proxied URLs** (`https://play.cinemaos.workers.dev/api/proxy?url=<enc>&referer=<enc>`):
  unwrap to the direct CDN url + referer (decode `url`/`referer` query params) so we don't
  depend on their worker; fall back to using the worker URL as-is if unwrap fails.
- `language` (when present: English/Original/Hindi/…) → the stream's language label; else 'VO'.
- `quality`: derived from the source's `bitrate` field (`4K`→4K, `FHD`→1080p, `HD`→720p,
  `Auto`/missing→HD). No exact resolution is given by cinemaos.
- Deliver each url through the **existing local/MediaFlow proxy** (`buildProxyUrl`, HLS branch),
  exactly like StreamFlix. No forceLocal needed (these are normal HLS, not the NetMirror .jpg case).

## Subtitles

From each decrypted response's `captions[]` (`{languageName, language, url(.srt)}`):
map to Stremio stream `subtitles: [{ id, url, lang }]`, `lang` = best-effort ISO-639
from `language`/`languageName`. Dedupe by lang across a title's sources. (OpenSubtitles
endpoint `/api/subtitles/opensubtitles?imdbId=` exists for extra languages but is **out of
scope** for v1 — the per-source captions are enough and free.)

## Files & wiring

- **`src/scrapers/cinemaos.ts`** (new): `getCinemaosStreams(tmdbId, imdbId, type, title, year, season?, episode?)`
  → `CinemaosStream[] = {quality, url, referer, language, server, subtitles:[{url,lang}]}`.
  Internals: `sign()`, `decrypt()`, `scrape(scraperId)`, `unwrapWorker()`, parallel fan-out
  over the curated scraper set, cache (scope `cinemaos`, movie 15min / series per-episode,
  negative TTL 5min). Needs `imdbId` — `getTmdbInfo` currently returns only `{title,year,tmdbId}`;
  extend it to also return `imdbId` (TMDB `external_ids` or the `find` response), or fetch it
  inside the scraper.
- **`config/cinemaos.json`** (new, bind-mounted, hot-reloaded via `fs.watch` like movix/flemmix):
  `{ base, primaryKey, secondaryKey, encKey, gt, scrapers:[...] }`. Lets us update the keys/token
  without a rebuild if cinemaos rotates them. Admin reload endpoint `/api/cinemaos/config?reload=true`.
- **`src/index.ts`**: import + add to the `Promise.all` fan-out in `handleStream`; process results
  into `streams[]` (name `CinemaOS <server>`, title `<lang> [<quality>] • <server>`, attach
  `subtitles`); add `cinemaos` to stats + `trackSourceResult` + `recordOutcome`; run through
  `filenameize` (getSceneMeta/buildFilename) like the others; pass `imdbId` down.
- **`src/metrics.ts`**: add `'cinemaos'` to `Scraper` type + `buffers` + `getAllMetrics`.

## Error handling / robustness

- Per-scraper failures (HTTP != 200, decrypt error, unknown scraper, empty sources) are
  caught and skipped — never fail the whole request.
- If the hardcoded keys/`_gt` stop working (cinemaos rotates them), all scrapers return
  403/garbage → `getCinemaosStreams` returns `[]` and logs a clear one-line warning
  (`[CinemaOS] auth rejected — keys may have rotated`). Fix = update `config/cinemaos.json`.
  How to re-extract when that happens: load `cinemaos.live/movie/watch/<tmdbId>` in a browser,
  read module 18310 (`generateContentHash`) for the two HMAC keys, module 91712 (`decryptData`)
  for `ENC_KEY`, and grep the bundle for the `_gt` literal.
- Concurrency cap on the parallel scraper fan-out (e.g. 8) to avoid hammering.
- All stream URLs pass `isAllowedUrl` via `buildProxyUrl`; the CDN hosts (1shows.app,
  kkphimplayer, etc.) will trip the domain allowlist → the Telegram bot's "add to whitelist"
  flow handles them (now that its polling is fixed), or we pre-seed common ones.

## Testing

- Unit-ish: `sign()` reproduces the known-good secret for Endgame (`ba7f3b4e283ecfcfd0…`).
- End-to-end via the running addon: `GET /<cfg>/stream/movie/tt4154796.json` and
  `…/movie/<sheep imdb>.json` return CinemaOS streams; fetch one master through `/proxy/manifest`
  and pull a segment (200). Series: a known show `…/stream/series/tmdb:<id>:1:1.json`.
- Confirm `subtitles[]` present on the stream objects.

## Out of scope (v1)

OpenSubtitles endpoint; querying all ~20 scrapers (curated subset only); the cinemaos
worker proxy as a hard dependency (we unwrap); anime providers.

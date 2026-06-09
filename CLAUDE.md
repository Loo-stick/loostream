# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # ts-node src/index.ts (hot source)
npm run build    # tsc → dist/ + copies configure.html into dist/
npm start        # node dist/index.js (expects build first)

docker compose up -d --build                    # rebuild + restart addon only
docker compose --profile telegram up -d --build # rebuild + restart addon + telegram bot
docker compose logs -f loostream                # follow addon logs
docker compose logs -f loostream-telegram       # follow bot logs
```

No test suite, no linter configured — `tsc --strict` is the only static check (runs during `npm run build`).

To rebuild the addon container after a TypeScript change you MUST `npm run build` locally first: the `Dockerfile` copies pre-built `dist/` (it does not run `tsc` inside the image).

## Deployment context (this host)

- Self-hosted at `https://streamzz.loostick.ovh/configure` via Apache2 reverse proxy → Cloudflare DNS → this server on `PORT` (default 7002).
- `app.set('trust proxy', 1)` in `src/index.ts:14` — the app reads `X-Forwarded-Proto` / `X-Forwarded-Host` to build correct absolute URLs in manifests and self-referencing proxy URLs. Keep that intact when editing `buildProxyUrl` / `getBaseUrl` / `getManifest`.
- `.env` is loaded by docker-compose; `config/` is bind-mounted (so `allowed-domains.json` and `telegram.json` are editable without rebuild).

## Big-picture architecture

This is a **Stremio addon that aggregates three independent scrapers** and serves the result via the Stremio addon protocol. It is NOT built on `stremio-addon-sdk` even though that package is a dependency — the HTTP surface is hand-rolled Express, with routes shaped to match what Stremio expects.

### Request flow

1. Stremio calls `GET /:config/stream/:type/:id.json` (or the no-config variant). `:config` is base64(JSON) of the user's `UserConfig` — parsed and validated by `parseConfig()` in `src/index.ts`.
2. `handleStream()` resolves IMDB/TMDB ID → title+year via TMDB (`getTmdbInfo`), then fans out **in parallel** to three scrapers:
   - `scrapers/netmirror.ts` — Netflix / Prime Video / Disney+ mirrors (NetMirror). Does cookie-bypass auth (`bypass()`), search, episode resolution, returns `{platform, contentId, quality}` tuples. Final HLS URL is fetched lazily in `handleStream` via `getStreamUrl()`.
   - `scrapers/streamflix.ts` — Hits `api.streamflix.app`, fuzzy-matches TMDB title against its data dump, composes stream URLs from CDN bases in its config JSON.
   - `scrapers/movix.ts` — Tries Purstream (direct m3u8) first, falls back to Cpasmal (embed URLs → resolved via `extractors/index.ts`).
3. Every stream URL passes through `buildProxyUrl()`, which chooses **MediaFlow** (external proxy, default) or **the local `/proxy/*` router** based on `config.proxy`. MediaFlow URLs are returned as-is; local proxy URLs are rewritten to point back at this host (using `X-Forwarded-*` headers).
4. `filterAndSortStreams()` applies the user's language/quality preferences from the decoded config. NetMirror is exempted from language filtering because its streams are multi-language HLS.

### The local proxy (`src/proxy.ts`)

Three endpoints under `/proxy`:
- `/proxy/manifest` — fetches an HLS manifest and **rewrites every variant/segment URL** to route back through `/proxy/manifest` or `/proxy/segment`. Headers from the original request are propagated as `h_*` query params (e.g., `h_referer`).
- `/proxy/segment` — streams a segment; can transform `.jpg` segments to `video/mp2t` (NetMirror workaround, flagged by `needsTransformer()` sniffing the manifest).
- `/proxy/stream` — passthrough for direct MP4/MKV. **Forwards the client's `Range` header** — this is required for MP4 seeking in Stremio.

All three enforce two SSRF protections in `isAllowedUrl()`:
1. Private-IP regex blocklist (`127.`, `10.`, `192.168.`, `169.254.`, IPv6 equivalents).
2. Domain **allowlist** loaded from `config/allowed-domains.json` (hot-reloaded via `fs.watch`). When a domain is blocked, the log line `Domain not whitelisted: <domain> - <url>` is the exact pattern the Telegram bot greps for.

Rate limiting (`apiLimiter`, 100 req/min/IP) is applied globally but **skipped for `/proxy/segment`** — HLS playback triggers many segment requests per minute per stream.

### MediaFlow vs local proxy

`USE_LOCAL_PROXY` / `config.proxy` switches between two worlds:
- **MediaFlow** (recommended, default): URLs built as `${MEDIAFLOW_URL}/proxy/hls/manifest.m3u8?d=<stream>&h_*=…`. The external MediaFlow instance handles bandwidth. For Cpasmal embeds, `extractors/index.ts:extractViaMediaFlow` hits `/extractor/video` with `redirect_stream=true`, captures the 302 `Location` header (Stremio does not follow 302s on HLS).
- **Local**: this server does all the proxying — high bandwidth. The extractors fall back to local HTML scraping (`extractVoe`, `extractUqload`) — only Voe and Uqload are implemented/reliable.

### Configuration model

Two layers, user config **wins** over env:
- `.env` (`TMDB_API_KEY`, `MEDIAFLOW_URL`, `MEDIAFLOW_PASSWORD`, `USE_LOCAL_PROXY`) — fallback defaults.
- Per-user base64 config in the URL — generated by `src/configure.html`, contains TMDB key, MediaFlow creds, quality/language prefs. Each Stremio user can have their own install URL with their own keys.

### Admin + Telegram bot

`telegram-bot.js` is a **separate container** that talks to the addon over Docker's internal network (`http://loostream:7002`). It does four things:
1. `spawn('docker', ['logs', '-f', ...])` — streams addon logs and greps for `Domain not whitelisted:` to fire Telegram alerts with "Add to whitelist" buttons. Requires the Docker socket mount in `docker-compose.yml`.
2. Polls `/api/health` every 5 min and alerts on state transitions.
3. Handles callback queries: editing `config/allowed-domains.json` + triggering `GET /proxy/domains?reload=true` to re-read the file live.
4. **Movix endpoint watcher** — every 6h scrapes the public Telegram preview `https://t.me/s/movix_site` for the latest announced `movix.<tld>`, follows HTML-level redirects (`meta refresh` / `window.location.replace`) to the real frontend, then greps the frontend's JS bundle for `https://api.movix.<tld>`. Writes to `config/movix-endpoints.json` and hits `/api/movix/endpoints?reload=true` — the scraper hot-reloads via `fs.watch`. Auto-applies; alerts the chat on change. Manual trigger: `/movix`.

Admin endpoints on the addon: `/api/stats` (in-memory counters initialized at `src/index.ts:38`), `/api/health` (does live HTTP checks), `/proxy/domains?reload=true`, `/api/movix/endpoints?reload=true`.

### Dead code / gotchas

- `src/scrapers/videasy.ts` exists but is not imported anywhere — legacy, ignore unless you're wiring it up.
- `src/index.ts.backup-mediaflow` is an old snapshot; `*.backup-*` is gitignored.
- `getStreamUrl()` is called **at stream-response time** for every NetMirror result (3 qualities × up to 3 platforms = up to 9 sequential HTTP round-trips to NetMirror). If you touch the stream handler, be aware this is the main latency source.
- `transformerCache` in `handleStream` is per-request, not global — recomputed each stream call.

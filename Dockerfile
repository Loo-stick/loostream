# Stage 1 — production dependencies (build tools present as a fallback in case
# better-sqlite3 has no prebuilt binary for this platform).
FROM node:22-trixie-slim AS deps
WORKDIR /app
# Build tools needed as fallback if better-sqlite3 prebuilt binary isn't available
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --only=production

# Stage 2 — compile TypeScript to dist/ inside the image, so a fresh clone
# (which has no dist/ — it is gitignored) builds without a local toolchain.
# --ignore-scripts skips better-sqlite3's native build here: tsc only needs the
# type definitions, not the compiled binary. `npm run build` also copies the
# configure/admin/login HTML into dist/.
FROM node:22-trixie-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 3 — runtime image.
FROM node:22-trixie-slim
WORKDIR /app
# curl : transport HTTP de secours pour les hôtes dont le Cloudflare refuse l'empreinte
# TLS de Node (nakastream depuis le 2026-09-12) — cf. src/curl-fetch.ts.
# ca-certificates est INDISPENSABLE avec curl : node:22-slim n'embarque pas de magasin
# système (Node utilise le sien, en interne), et sans lui curl échoue sur
# « error setting certificate file » avant même la poignée de main TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist
COPY loostream.png ./

ENV NODE_ENV=production

EXPOSE 7002
CMD ["node", "dist/index.js"]

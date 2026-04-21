FROM node:22-slim AS deps
WORKDIR /app
# Build tools needed as fallback if better-sqlite3 prebuilt binary isn't available
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --only=production

FROM node:22-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY dist ./dist
COPY src/configure.html ./dist/
COPY loostream.png ./

ENV NODE_ENV=production

EXPOSE 7002
CMD ["node", "dist/index.js"]

FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist
COPY src/configure.html ./dist/
COPY loostream.png ./

ENV NODE_ENV=production

EXPOSE 7002
CMD ["node", "dist/index.js"]

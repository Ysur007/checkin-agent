# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8787 \
    DATA_DIR=/data \
    BROWSER_LOGIN=0 \
    XDG_CACHE_HOME=/tmp/cache \
    XDG_CONFIG_HOME=/tmp/config \
    HOME=/tmp
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /tmp/cache /tmp/config \
  && chown -R node:node /data /app /tmp/cache /tmp/config

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/plugins ./plugins
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/api/health/ready || exit 1
CMD ["node", "dist/main.js"]

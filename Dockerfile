# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS web-builder
ENV CI=true COREPACK_ENABLE_STRICT=0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@12.3.4 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:24-bookworm-slim AS deps
ENV CI=true COREPACK_ENABLE_STRICT=0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@12.3.4 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 sqlite3 lsof \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=web-builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=web-builder /app/index.html /app/vite.config.ts /app/tsconfig.json /app/tsconfig.server.json ./
COPY --from=web-builder /app/dist ./dist
COPY --from=web-builder /app/server ./server
COPY --from=web-builder /app/shared ./shared
COPY --from=web-builder /app/scripts ./scripts
COPY --from=web-builder /app/src ./src
COPY --from=web-builder /app/public ./public
COPY --from=web-builder /app/plugins ./plugins
COPY --from=web-builder /app/packages ./packages
COPY --from=web-builder /app/support ./support
COPY --from=web-builder /app/tools ./tools
COPY --from=web-builder /app/vendor ./vendor
COPY --from=web-builder /app/docs ./docs

RUN mkdir -p /data && chown -R node:node /app /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5288 \
    DELIVERY_DATA_DIR=/data \
    DELIVERY_WORKSPACE_SUPERVISOR=systemd \
    DELIVERY_SCHEDULER_DISABLED=0

USER node
VOLUME ["/data"]
EXPOSE 5288

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 5288) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--import", "./server/plugins/bootstrap.mjs", "--import", "tsx", "server/index.ts"]

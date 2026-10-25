# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci
COPY tsconfig.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ARG CODEX_VERSION=0.163.0
ARG CLAUDE_CODE_VERSION=2.1.302
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git openssh-client procps iproute2 lsof ripgrep python3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist/ shared/dist/
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist/ server/dist/
COPY --from=build /app/client/dist/ client/dist/
# In-app help documents (DocViewer reads them through /api/docs).
COPY docs/ docs/
COPY --chmod=755 scripts/container/entrypoint.sh /usr/local/bin/arco-entrypoint
RUN mkdir -p /data/home /data/uploads /projects \
    && chown -R node:node /data /projects
ENV NODE_ENV=production ARCO_DEPLOYMENT=docker HOME=/data/home CODEX_HOME=/data/home/.codex \
    ARCHON_SERVE_CLIENT=1 ARCHON_UPLOADS_DIR=/data/uploads \
    ARCHON_HOST=0.0.0.0 ARCHON_PORT=3001 \
    ARCHON_OAUTH_CALLBACK_HOST=0.0.0.0
USER node
EXPOSE 3001 53692
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/arco-entrypoint"]
CMD ["node", "server/dist/index.js"]

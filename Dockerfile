# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────────
# Agent Gateway — multi-stage build for the @agent-gateway/gateway package.
#
# Produces a small, self-contained runtime image that runs anywhere Docker runs
# (Azure Container Apps, AKS, ECS, Cloud Run, a plain VM, etc.).
#
#   Build:  docker build -t agent-gateway:latest .
#   Run:    docker run --rm -p 3000:3000 \
#             -e GATEWAY_DATA_DIR=/app/data \
#             -v "$PWD/data:/app/data" \
#             --env-file data/.env \
#             agent-gateway:latest
# ─────────────────────────────────────────────────────────────────────────────

# Pin a Node 22 base (engines: node >=22). bookworm-slim keeps glibc compatible
# between build and runtime stages so the better-sqlite3 native binary just works.
ARG NODE_IMAGE=node:22-bookworm-slim

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /repo

# Native toolchain for compiling better-sqlite3 (listed in onlyBuiltDependencies).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm 10 via corepack (pinned in engines: pnpm >=10).
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10 --activate

# 1) Install deps first (cached unless manifests/lockfile change).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/gateway/package.json packages/gateway/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @agent-gateway/gateway...

# 2) Copy gateway sources + shared TS base config, then build.
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/gateway packages/gateway
RUN pnpm --filter @agent-gateway/gateway build

# 3) Produce a pruned, production-only, self-contained bundle (node_modules + dist).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm deploy --legacy --filter=@agent-gateway/gateway --prod /prod/gateway

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    GATEWAY_DATA_DIR=/app/data

# Tiny init for correct signal handling (SIGTERM → graceful shutdown).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Self-contained app bundle from the builder.
COPY --from=builder /prod/gateway ./

# Bake in the gateway config. Secrets stay as ${ENV_VAR} references and are
# supplied at runtime (Container App env vars / secrets), never stored here.
COPY data/gateway.config.yaml /app/data/gateway.config.yaml

# Runtime state lives here; mount a volume to persist gateway.db + weixin/*.json.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

# Health endpoint served by the shared Hono server (GET /health → {status:"ok"}).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]

# Indexer runtime — Ponder against a Postgres addon in prod, pglite when DATABASE_URL
# is absent (matches local dev). Build works from the repo root so pnpm-workspace can
# resolve the @vm/indexer workspace entry.
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.7.1 --activate

# Workspace bootstrap — copy the manifests + lockfile first so `pnpm install`
# layer caches. --frozen-lockfile requires pnpm-lock.yaml at the workspace root.
# tsconfig.base.json is `extends`-ed by indexer/tsconfig.json which ponder loads
# at startup; without it the process exits before serving /health.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY indexer/package.json ./indexer/
RUN pnpm install --filter @vm/indexer --frozen-lockfile

# App source.
COPY indexer/ ./indexer/

WORKDIR /app/indexer

# Ponder listens on 42069 by default. Railway injects $PORT; export it to Ponder via
# the CLI's --port flag so the platform can route traffic to us.
ENV PORT=42069
EXPOSE 42069

# `ponder start` = prod mode (Postgres, no dev-server niceties). Reads DATABASE_URL
# from env; falls back to pglite locally when unset (see ponder.config.ts).
CMD ["sh", "-c", "pnpm exec ponder start --port ${PORT:-42069} --hostname 0.0.0.0"]

FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install Foundry
RUN curl -L https://foundry.paradigm.xyz | bash \
  && /root/.foundry/bin/foundryup \
  && cp /root/.foundry/bin/forge /usr/local/bin/forge \
  && cp /root/.foundry/bin/cast /usr/local/bin/cast \
  && cp /root/.foundry/bin/anvil /usr/local/bin/anvil \
  && forge --version

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.7.1 --activate

# Copy workspace root manifest + lockfile so pnpm resolves the workspace protocol.
# --frozen-lockfile needs pnpm-lock.yaml present at the workspace root.
# tsconfig.base.json is `extends`-ed by compile-service/tsconfig.json — without it
# the `build` step's `tsc --noEmit` falls back to bare defaults (ES5 target, no
# node module resolution) and every top-level await / import.meta blows up.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY compile-service/package.json ./compile-service/
RUN pnpm install --filter @vm/compile-service --frozen-lockfile

COPY compile-service/ ./compile-service/
COPY shared/ ./shared/
# Shipped epoch JSONs (contracts/tmp/epoch/epoch<N>.json + epoch<N>.meta.json).
# db.ts::_seedShippedEpochs reads these on migrate() and backfills
# app.rewards_epochs + app.rewards_leaves. Without this COPY the seed silently
# no-ops in production and the frontend claim button stays inactive even
# after the on-chain addEpoch broadcast.
COPY contracts/tmp/epoch/ ./contracts/tmp/epoch/
# `build` currently only typechecks (no emit). Run directly through tsx so we don't
# depend on a dist/ output — swap to a real compile step when the surface stabilises.
RUN pnpm --filter @vm/compile-service build

EXPOSE 3001
# Railway sets $PORT; fall through to 3001 for local docker runs.
ENV PORT=3001
CMD ["pnpm", "--filter", "@vm/compile-service", "exec", "tsx", "src/server.ts"]

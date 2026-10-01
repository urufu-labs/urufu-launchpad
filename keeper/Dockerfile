# DN404 tax keeper. Built from the repo root so the pnpm workspace resolves
# @vm/keeper (same pattern as indexer/Dockerfile).
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.1 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY keeper/package.json ./keeper/
RUN pnpm install --filter @vm/keeper --frozen-lockfile

COPY keeper/ ./keeper/
WORKDIR /app/keeper

# Node 22 runs the TypeScript sources directly with type stripping.
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/index.ts"]

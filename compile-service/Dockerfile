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

# Copy workspace root manifest so pnpm resolves the workspace protocol
COPY pnpm-workspace.yaml package.json ./
COPY compile-service/package.json ./compile-service/
RUN pnpm install --filter @vm/compile-service --frozen-lockfile

COPY compile-service/ ./compile-service/
COPY shared/ ./shared/
RUN pnpm --filter @vm/compile-service build

EXPOSE 3001
CMD ["node", "compile-service/dist/server.js"]

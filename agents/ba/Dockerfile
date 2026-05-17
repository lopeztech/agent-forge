# Multi-stage build: bundle the agent with esbuild, then ship a slim runtime image.
# Single-file bundle means we don't need npm/node_modules in the runtime layer.

# ---------- builder ----------
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /build

# Cache install layer by copying manifest first.
COPY package.json package-lock.json ./
RUN npm ci

# Source needed by the bundler: agent code + shared helpers.
COPY tsconfig.json ./
COPY shared ./shared
COPY agents/ba/src ./agents/ba/src

RUN npx esbuild agents/ba/src/index.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --minify \
      --outfile=/build/dist/index.js

# ---------- runtime ----------
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /build/dist/index.js /app/index.js

# Non-root user for defence in depth. Fargate doesn't require this but
# AWS distroless / scratch wouldn't have node, so alpine + a user is the
# cheapest hardening.
RUN addgroup -S agent && adduser -S agent -G agent && chown -R agent:agent /app
USER agent

ENV NODE_ENV=production

ENTRYPOINT ["node", "/app/index.js"]

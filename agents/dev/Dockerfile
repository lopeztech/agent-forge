# Multi-stage build: bundle the agent with esbuild, then ship a slim runtime image.
# Single-file bundle means we don't need npm/node_modules in the runtime layer.

# ---------- builder ----------
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY shared ./shared
COPY agents/dev/src ./agents/dev/src

RUN npx esbuild agents/dev/src/index.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --minify \
      --outfile=/build/dist/index.js

# ---------- runtime ----------
FROM node:22-alpine

WORKDIR /app

# git: clone the target repo into /tmp/<run> for the agent to read + (B.3)
#      branch/commit/push from.
# ca-certificates: TLS to api.github.com and github.com.
RUN apk add --no-cache git ca-certificates

COPY --from=builder /build/dist/index.js /app/index.js

RUN addgroup -S agent && adduser -S agent -G agent && chown -R agent:agent /app
USER agent

ENV NODE_ENV=production

ENTRYPOINT ["node", "/app/index.js"]

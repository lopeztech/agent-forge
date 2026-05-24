# Multi-stage build: bundle the agent with esbuild, then ship a slim runtime image.

# ---------- builder ----------
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY shared ./shared
COPY agents/test/src ./agents/test/src

RUN npx esbuild agents/test/src/index.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --minify \
      --outfile=/build/dist/index.js

# ---------- runtime ----------
FROM node:22-alpine

WORKDIR /app

# git: fetch + checkout the PR branch Dev opened, commit + push test additions.
# bash: agent's bash tool dispatches through /bin/bash explicitly.
# ca-certificates: TLS to api.github.com / github.com.
RUN apk add --no-cache git bash ca-certificates

COPY --from=builder /build/dist/index.js /app/index.js

RUN addgroup -S agent && adduser -S agent -G agent && chown -R agent:agent /app
USER agent

ENV NODE_ENV=production

ENTRYPOINT ["node", "/app/index.js"]

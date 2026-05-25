# Multi-stage build: bundle the agent with esbuild, then ship the runtime
# image with semgrep + gitleaks pre-installed.
#
# B2 (2026-05-25) replaces the prior "agent installs scanners on the fly"
# approach. Per-run install cost was ~30s/run; pre-installing makes the
# Security review responsive. semgrep is a Python package (needs a Python
# runtime); gitleaks is a static Go binary. Bookworm-slim base supports
# both cleanly.

# ---------- builder ----------
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY shared ./shared
COPY agents/security/src ./agents/security/src

RUN npx esbuild agents/security/src/index.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --minify \
      --outfile=/build/dist/index.js

# ---------- runtime ----------
FROM node:22-bookworm-slim

WORKDIR /app

# Pin scanner versions for reproducible builds. Bump as needed when:
# - semgrep ships a security-rule release we want (~monthly cadence)
# - gitleaks adds a detector class we care about
ARG SEMGREP_VERSION=1.95.0
ARG GITLEAKS_VERSION=8.21.2
ARG TARGETARCH

# git: clone the PR branch.
# bash: agent's bash tool dispatches through /bin/bash explicitly.
# ca-certificates: TLS to api.github.com / github.com.
# python3 + pip: semgrep runtime.
# curl: gitleaks tarball fetch (could be wget, but curl is more common).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        python3 \
        python3-pip \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

# semgrep — Python wheel install. --break-system-packages is fine inside
# the container (PEP 668 guards against system-package collisions on a
# multi-user host, irrelevant in a single-purpose image).
RUN pip install --no-cache-dir --break-system-packages "semgrep==${SEMGREP_VERSION}"

# gitleaks — static binary. Release URL uses `arm64` and `x64` for the two
# Linux archs; Docker's TARGETARCH uses `arm64` and `amd64`. Map between.
RUN GITLEAKS_ARCH=$(case "${TARGETARCH:-arm64}" in \
        "arm64") echo "arm64" ;; \
        "amd64") echo "x64" ;; \
        *) echo "x64" ;; \
    esac) && \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GITLEAKS_ARCH}.tar.gz" \
        | tar -xz -C /usr/local/bin gitleaks && \
    chmod +x /usr/local/bin/gitleaks

# Smoke-test the scanners at build time so a broken pin fails the CI
# image build, not the agent's first real run.
RUN semgrep --version && gitleaks version

COPY --from=builder /build/dist/index.js /app/index.js

RUN groupadd -r agent && useradd -r -g agent agent && chown -R agent:agent /app
USER agent

ENV NODE_ENV=production

ENTRYPOINT ["node", "/app/index.js"]

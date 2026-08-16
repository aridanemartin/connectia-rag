# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────────────────
# Builder – compile TypeScript
# ──────────────────────────────────────────────────────────────────────────
FROM node:24.17.0-bookworm-slim AS builder

WORKDIR /app

# Install ALL dependencies (including dev: tsx, typescript, etc.)
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# Compile TypeScript → dist/
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ──────────────────────────────────────────────────────────────────────────
# Runtime – production image (no dev dependencies)
# ──────────────────────────────────────────────────────────────────────────
FROM node:24.17.0-bookworm-slim AS runner

ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output and scripts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts

# Create persistent data directories
RUN mkdir -p /data/sqlite /data/tmp

# Run as an unprivileged user (the official node image already provides the
# "node" user; we just need to ensure our /data directories are writable).
RUN chown -R node:node /data /app

USER node

EXPOSE 3000

# HTTP liveness health check – uses Node's built-in fetch (no curl required)
HEALTHCHECK \
  --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e \
    "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]

# ──────────────────────────────────────────────────────────────────────────
# Dev – hot-reload development image (includes dev dependencies)
# ──────────────────────────────────────────────────────────────────────────
FROM node:24.17.0-bookworm-slim AS dev

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json ./

RUN mkdir -p /data/sqlite /data/tmp && chown -R node:node /data /app

USER node

EXPOSE 3000

CMD ["npm", "run", "dev"]
# syntax=docker/dockerfile:1.7
# ---------- Video Streaming web app (Node.js) ----------
# Build context is ./services (so the shared ./web-common library can be copied);
# streaming-web/Dockerfile.dockerignore limits what is sent to the daemon.

ARG NODE_VERSION=22

# ---------- production dependencies only ----------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app/streaming-web
COPY streaming-web/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi

# ---------- test stage (used by CI: docker build --target test) ----------
FROM node:${NODE_VERSION}-alpine AS test
WORKDIR /app/streaming-web
COPY web-common /app/web-common
COPY streaming-web/ ./
COPY --from=deps /app/streaming-web/node_modules ./node_modules
RUN node --test

# ---------- runtime ----------
FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.title="vss-streaming-web" \
      org.opencontainers.image.description="Video Streaming web app for the Video Streaming System"
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production PORT=3000
WORKDIR /app/streaming-web
COPY --from=deps /app/streaming-web/node_modules ./node_modules
COPY web-common/*.js /app/web-common/
COPY web-common/public /app/web-common/public
COPY streaming-web/package.json ./
COPY streaming-web/src ./src
COPY streaming-web/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["node", "/app/web-common/healthcheck.js"]
CMD ["node", "src/index.js"]

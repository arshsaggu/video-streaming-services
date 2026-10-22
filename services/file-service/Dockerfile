# syntax=docker/dockerfile:1.7
# ---------- File System Service (Node.js, no dependencies) ----------
# Multi-stage: an Alpine stage assembles the app and the storage directory, a
# test stage runs the suite, and the runtime image is distroless Node.js:
# no shell, no package manager, no npm - only the node binary and our code.
# Both stages exist for linux/amd64 and linux/arm64.

ARG NODE_VERSION=22

# ---------- assemble ----------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /out/app
COPY package.json ./
COPY src ./src
# Storage dir pre-created for the distroless nonroot user (65532); a new named
# volume mounted on /data inherits this ownership, so no root step is needed.
RUN mkdir -p /out/data/videos

# ---------- test stage (used by CI: docker build --target test) ----------
FROM node:${NODE_VERSION}-alpine AS test
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
RUN node --test

# ---------- runtime ----------
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12:nonroot AS runtime
LABEL org.opencontainers.image.title="vss-file-service" \
      org.opencontainers.image.description="Internal video file storage service for the Video Streaming System"
WORKDIR /app
COPY --from=build /out/app ./
COPY --from=build --chown=65532:65532 /out/data /data
USER 65532:65532
ENV NODE_ENV=production STORAGE_DIR=/data/videos PORT=8080
EXPOSE 8080
# No shell or curl in distroless: a tiny Node script probes /healthz.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/src/healthcheck.js"]
# The distroless entrypoint is the node binary itself.
CMD ["src/index.js"]

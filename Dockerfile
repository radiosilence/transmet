# The web build is architecture-independent, so it runs once on the build
# host; the final stage only copies, so a multi-arch build emulates nothing.
FROM --platform=$BUILDPLATFORM oven/bun:1 AS web
WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./
RUN bun run build

# The comic itself, pushed once from a machine holding the source by
# scripts/push-pages. First, because it is 2.5GB and never changes, so a code
# change ships only the layers above it.
FROM ghcr.io/radiosilence/transmet-pages:1 AS pages

FROM oven/bun:1-distroless
COPY --from=pages /pages /pages
COPY --from=web /web/dist /app/web
COPY server/server.ts /app/server.ts
ENV PORT=3000 WEB_DIR=/app/web PAGES_DIR=/pages
EXPOSE 3000
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/bun", "/app/server.ts"]

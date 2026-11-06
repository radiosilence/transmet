# The web build is architecture-independent, so it runs once on the build
# host; the final stage only copies, so a multi-arch build emulates nothing.
FROM --platform=$BUILDPLATFORM oven/bun:1 AS web
WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./
RUN bun run build

# The server, cross-compiled on the build host to a static musl binary for the
# target architecture, so it needs nothing from the image it runs in.
FROM --platform=$BUILDPLATFORM ghcr.io/rust-cross/cargo-zigbuild:0.24.1 AS server
ARG TARGETARCH
WORKDIR /server
COPY server ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/server/target \
    case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-musl ;; \
      arm64) target=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && rustup target add "$target" \
    && cargo zigbuild --release --locked --target "$target" \
    && cp "target/$target/release/transmet" /transmet

# The comic itself, pushed once from a machine holding the source by
# scripts/push-pages. It is the first layer because it is 2.5GB and never
# changes, so a code change ships only the layers above it.
FROM ghcr.io/radiosilence/transmet-pages:4 AS pages

FROM scratch
COPY --from=pages /pages /pages
# The token exchange goes to the provider's public hostname when no backchannel
# is configured, and rustls reads the system trust store.
COPY --from=gcr.io/distroless/static:latest \
     /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=web /web/dist /app/web
COPY --from=server /transmet /transmet
ENV PORT=3000 WEB_DIR=/app/web PAGES_DIR=/pages
EXPOSE 3000
USER 65532:65532
ENTRYPOINT ["/transmet"]

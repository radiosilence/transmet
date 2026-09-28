# transmet

A mobile-first reader for a personal copy of *Transmetropolitan*, served from
the jaritanet cluster behind the estate's single sign-on, with a shared password
as the fallback.

## Layout

- `scripts/extract.py` pulls every page out of the source PDFs as the original
  embedded image bytes, so nothing is re-encoded. It also writes a WebP
  thumbnail per page and `manifest.json` with each page's dimensions, which the
  reader lays out from before any image loads.
- `scripts/push-pages` publishes `pages/` as `ghcr.io/radiosilence/transmet-pages`,
  a data-only image. CI has no access to the source, so the pages are pushed
  once from a machine that has them and the app image copies from that.
- `server/server.ts` is the sign-in gate and static server. Sign-on goes through
  the estate's Hydra, whose GitHub allowlist is what decides who reads; the
  password works without it, so an outage at the provider locks nobody out.
  Either way in sets the same cookie, an HMAC keyed by the password, so there is
  no session store and changing the password signs every device out.
- `web/` is the reader. Pages are served by PhotoSwipe, which handles pinch,
  pan and double-tap zoom. A service worker keeps pages in the Cache API: the
  open issue and the next few (configurable) are saved automatically, and any
  issue or arc can be saved explicitly for reading without signal. Progress is
  kept in `localStorage`, per device.
- `deploy/pulumi` is `@radiosilence/transmet-pulumi`, the chart jaritanet
  consumes. It shares its version with the image.

## Images are private

The app image contains the comic, so both images and the chart package stay
private. The cluster pulls with a registry credential the chart takes as
`registry`.

## Updating the pages

```sh
rsync -a lady:/srv/files/.transmetropolitan/c2c/ source/
uvx --with pymupdf --with pillow python scripts/extract.py source pages
scripts/push-pages 1
```

## Releasing

Bump `deploy/pulumi/package.json` and `APP_VERSION` in
`deploy/pulumi/src/versions.ts` together. A push to `main` builds the image and,
for a version not yet published, tags it and publishes the chart.

## Local

```sh
cd web && bun install && bun run build && cd ..
TRANSMET_PASSWORD=test WEB_DIR=$PWD/web/dist PAGES_DIR=$PWD/pages bun server/server.ts
```

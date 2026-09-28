# transmet

A mobile-first reader for a personal copy of *Transmetropolitan*, served from
the jaritanet cluster behind the estate's single sign-on, with a shared password
as the fallback.

The password is `transmetropolitan`

Please fucking read this.

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
- `scripts/ocr.py` transcribes the lettering on each page with macOS Vision
  (local, free) into `<issue>/text.json`, which the reader gives screen readers
  as alt text and announces on each page turn. Sound effects and display
  lettering are dropped because they read aloud as noise; reading order is by
  position, so it is approximate on complex layouts.
- `scripts/describe.py` writes what each page shows, and its lettering
  corrected and attributed to speakers, into `<issue>/scene.json`, using Claude
  Sonnet through the `claude` CLI. Haiku was tried first and misidentified who
  is drawn: it took a narrated subject for the person in the panel and a
  talking bulldog for a man. Pages go a dozen at a time with
  their transcript, a character guide and a running story summary carried
  across issues, so descriptions keep track of who is who. With the transcript
  it makes each issue's text edition at `/text/<issue>`, readable straight
  through by a screen reader.
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
uvx --with ocrmac python scripts/ocr.py pages
uvx --with pillow python scripts/describe.py pages
scripts/push-pages 2
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

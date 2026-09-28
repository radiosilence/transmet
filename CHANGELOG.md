# Changelog

## 0.3.0

- A text edition of each issue at `/text/<issue>`: a description of every page
  and its lettering, for screen readers. The reader uses the same text as alt
  text and announces it on each page turn. Requires `transmet-pages:2`.

## 0.2.0

- Single sign-on through the jaritanet OIDC provider, with the password kept as
  a fallback. The chart takes `oidc` and returns the client to register.

## 0.1.0

- Reader, password gate, offline saving and the jaritanet chart.

# Changelog

## 0.3.4

- On wide screens a whole arc fits on its shelf, and the arrows are hidden;
  six covers overflowed by a few pixels, so the arrows scrolled by that much and
  appeared to do nothing.
- Corrects the description of #55 page 16, which swapped Channon and Yelena.
  Requires `transmet-pages:4`.

## 0.3.3

- Each character is named the same way throughout the transcripts ("Spider",
  not sometimes "Spider Jerusalem"), so a screen reader presents one person.
  Requires `transmet-pages:3`.

## 0.3.2

- Sign-on failed with a Bad Gateway when the pod shared a node with the
  ingress, because the token exchange went out to the provider's public
  hostname and Cilium drops that. The chart takes `oidc.backchannel` to reach
  the provider inside the cluster, and a failed exchange now returns to the
  login page instead of timing out.

## 0.3.1

- Shelves have arrow buttons for a mouse, which cannot scroll them sideways.
- While the reader's bars show, the page fits between them instead of under
  them.

## 0.3.0

- A text edition of each issue at `/text/<issue>`: a description of every page
  and its lettering, for screen readers. The reader uses the same text as alt
  text and announces it on each page turn. Dialogue is attributed to its
  speakers. Requires `transmet-pages:2`.

## 0.2.0

- Single sign-on through the jaritanet OIDC provider, with the password kept as
  a fallback. The chart takes `oidc` and returns the client to register.

## 0.1.0

- Reader, password gate, offline saving and the jaritanet chart.

"""
Transcribes the lettering on every page for screen readers, writing
`<issue>/text.json` beside the pages: one list of balloons per page, in rough
reading order.

Uses the macOS Vision framework, so it runs locally, costs nothing per page and
needs a Mac. Vision returns lines; lines are merged into balloons by proximity,
and lines much taller than the page's body lettering (logos, titles, sound
effects) are dropped, since read aloud they are noise.

Reading order is approximate: balloons are taken in bands from the top of the
page, left to right within a band. Issues that already have a transcript are
skipped, so an interrupted run resumes.

Usage: uvx --with ocrmac python scripts/ocr.py pages
"""

import json
import re
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

# Vision's boxes are normalised to the page, origin bottom-left.
DISPLAY_RATIO = 2.2
BAND = 0.06


def lines(path):
    from ocrmac import ocrmac

    found = ocrmac.OCR(str(path), recognition_level="accurate", language_preference=["en-US"]).recognize()
    return [(t.strip(), x, y + h, w, h) for t, conf, (x, y, w, h) in found if conf >= 0.5 and t.strip()]


def balloons(found):
    if not found:
        return []
    body = statistics.median(h for *_, h in found)
    found = sorted((l for l in found if l[4] <= body * DISPLAY_RATIO), key=lambda l: -l[2])

    groups = []
    for line in found:
        _, x, top, w, h = line
        for g in groups:
            _, gx, gtop, gw, gh = g[-1]
            close = gtop - gh - top < h * 1.6
            overlaps = x < gx + gw + h and gx < x + w + h
            if close and overlaps:
                g.append(line)
                break
        else:
            groups.append([line])

    ordered = sorted(groups, key=lambda g: (round(-g[0][2] / BAND), g[0][1]))
    return [tidy(g) for g in ordered]


def tidy(group):
    text = ""
    for t, *_ in group:
        # A single trailing hyphen splits a word; a double one is a dash.
        text = text[:-1] + t if re.search(r"[^-]-$", text) else f"{text} {t}".strip()
    # All-capitals lettering is read letter by letter by some screen readers.
    letters = [c for c in text if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) > 0.8 * len(letters):
        text = re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m[1] + m[2].upper(), text.lower())
        text = re.sub(r"\bi\b", "I", text)
    return text


def page(path):
    return balloons(lines(path))


if __name__ == "__main__":
    root = Path(sys.argv[1])
    issues = json.loads((root / "manifest.json").read_text())["issues"]
    with ProcessPoolExecutor() as pool:
        for issue in issues:
            out = root / issue["id"] / "text.json"
            if out.exists():
                continue
            text = list(pool.map(page, [root / p["src"] for p in issue["pages"]]))
            out.write_text(json.dumps(text, ensure_ascii=False, separators=(",", ":")))
            print(f"{issue['id']}: {sum(map(len, text))} balloons", flush=True)

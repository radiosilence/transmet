"""
Extracts every page of the source PDFs as the original embedded image bytes,
plus a manifest the reader lays pages out from.

Each source page is exactly one full-bleed image with no rotation, so copying
the stream out is lossless; nothing is decoded or re-encoded. A small WebP
thumbnail per page feeds the library, the page scrubber and the placeholder
shown while the full page loads.

Usage: uvx --with pymupdf --with pillow python scripts/extract.py <source dir> <out dir>
"""

import io
import json
import re
import sys
from pathlib import Path

import pymupdf
from PIL import Image

THUMB_HEIGHT = 360

src, out = Path(sys.argv[1]), Path(sys.argv[2])
issues = []

for pdf in sorted(src.glob("*.pdf")):
    m = re.match(r"Transmetropolitan (?:(\d+)|S(\d) - (.+))\.pdf$", pdf.name)
    if not m:
        sys.exit(f"unrecognised source file: {pdf.name}")
    num, special, title = m.groups()
    slug = num if num else f"s{special}"

    doc = pymupdf.open(pdf)
    pages = []
    (out / slug).mkdir(parents=True, exist_ok=True)
    for i, page in enumerate(doc):
        (xref, *_), = page.get_images(full=True)
        img = doc.extract_image(xref)
        name = f"{i + 1:03}.{img['ext']}"
        thumb = f"{i + 1:03}.thumb.webp"
        (out / slug / name).write_bytes(img["image"])
        with Image.open(io.BytesIO(img["image"])) as im:
            im.draft("RGB", (im.width * THUMB_HEIGHT // im.height, THUMB_HEIGHT))
            im = im.convert("RGB")
            im.thumbnail((10_000, THUMB_HEIGHT), Image.LANCZOS)
            im.save(out / slug / thumb, "WEBP", quality=72, method=6)
        pages.append({
            "src": f"{slug}/{name}",
            "thumb": f"{slug}/{thumb}",
            "w": img["width"],
            "h": img["height"],
        })

    issues.append({
        "id": slug,
        "number": int(num) if num else None,
        "title": title,
        "pages": pages,
    })

issues.sort(key=lambda i: (i["number"] is None, i["number"] or 0, i["id"]))
(out / "manifest.json").write_text(json.dumps({"issues": issues}, separators=(",", ":")))
print(f"{len(issues)} issues, {sum(len(i['pages']) for i in issues)} pages")

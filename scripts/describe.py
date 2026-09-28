"""
Writes the text edition: what each page shows, for blind readers, as
`<issue>/scene.json` beside the pages ({"pages": [one per page], "story"}).

Pages go to Claude Haiku through the `claude` CLI, a dozen at a time with the
lettering from scripts/ocr.py, a character guide, and the story so far. The
story is carried from chunk to chunk and issue to issue, which is what lets a
description say "Channon" rather than "a woman" and follow a plot across
issues, so the issues of one run are done in order. A run starts from the
story of the finished issue immediately before its first, or fresh if there is
none, and resumes from the last finished issue if interrupted.

Pages are downscaled first: the lettering is already transcribed, so the art
only needs enough resolution to be recognised.

Usage: uvx --with pillow python scripts/describe.py pages [issue ids]

Given issue ids, only those are described, which lets separate story arcs run
in parallel at the cost of each arc starting without the one before it. Each
call's API-equivalent cost is printed, which is the measure of how much plan
usage a run takes.
"""

import base64
import io
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

CHUNK = 12
HEIGHT = 1024

SYSTEM = """You write the text edition of the comic Transmetropolitan for blind
readers. For each page, describe in two to four plain sentences what is shown:
the setting, who is there, what they do, and who speaks the lettered lines. Say
when a page is an advertisement or back matter, in one sentence. Do not repeat
the dialogue verbatim; the reader hears it separately.

Name characters when recognisable, and keep continuity with the story so far.
Spider Jerusalem is a foul-mouthed gonzo journalist: bearded and hermit-like
at the very start of issue 1, afterwards shaven-headed and tattooed, in
mismatched tinted glasses. Channon Yarrow and Yelena Rossini are his "filthy
assistants". Mitchell Royce is his editor at The Word. Spider's cat smokes
black cigarettes. The Beast is the President; Gary Callahan, "The Smiler",
runs against him."""


def page_blocks(path):
    im = Image.open(path).convert("RGB")
    im.thumbnail((10_000, HEIGHT), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(buf.getvalue()).decode()},
    }


def describe(issue, pages, text, first, story):
    content = [{"type": "text", "text": f"Issue {issue}. Story so far: {story or 'This is the beginning.'}"}]
    for n, (path, lettering) in enumerate(zip(pages, text), first):
        content.append({"type": "text", "text": f"Page {n}. Lettering (OCR, may be imperfect): {json.dumps(lettering)}"})
        content.append(page_blocks(path))
    content.append({
        "type": "text",
        "text": f'Return JSON only: {{"pages": [{len(pages)} descriptions, in order], "story": "the story so far, updated, under 300 words"}}',
    })
    message = json.dumps({"type": "user", "message": {"role": "user", "content": content}})

    # Run outside any project so no CLAUDE.md or settings reach the prompt.
    with tempfile.TemporaryDirectory() as cwd:
        for _ in range(3):
            out = subprocess.run(
                ["claude", "-p", "--verbose", "--model", "haiku", "--tools", "", "--setting-sources", "",
                 "--no-session-persistence", "--input-format", "stream-json", "--output-format", "stream-json",
                 "--system-prompt", SYSTEM],
                input=message, capture_output=True, text=True, cwd=cwd,
            ).stdout
            result = next((json.loads(l) for l in out.splitlines() if '"type":"result"' in l), None)
            if result:
                print(f"  {issue} p{first}: ${result.get('total_cost_usd', 0):.4f}", flush=True)
            try:
                reply = json.loads(re.search(r"\{.*\}", result["result"], re.S)[0])
                if len(reply["pages"]) == len(pages):
                    return reply["pages"], reply["story"]
            except (TypeError, KeyError, json.JSONDecodeError):
                pass
            print(f"  retrying {issue} from page {first}", flush=True)
    sys.exit(f"gave up on {issue} from page {first}")


if __name__ == "__main__":
    root = Path(sys.argv[1])
    only = set(sys.argv[2:])
    story = ""
    for issue in json.loads((root / "manifest.json").read_text())["issues"]:
        out = root / issue["id"] / "scene.json"
        if out.exists():
            story = json.loads(out.read_text())["story"]
            continue
        if only and issue["id"] not in only:
            story = ""
            continue
        name = issue["title"] or f"#{issue['number']}"
        text = json.loads((root / issue["id"] / "text.json").read_text())
        paths = [root / p["src"] for p in issue["pages"]]
        scenes = []
        for at in range(0, len(paths), CHUNK):
            described, story = describe(name, paths[at : at + CHUNK], text[at : at + CHUNK], at + 1, story)
            scenes += described
        out.write_text(json.dumps({"pages": scenes, "story": story}, ensure_ascii=False, separators=(",", ":")))
        print(f"{issue['id']}: described {len(scenes)} pages", flush=True)

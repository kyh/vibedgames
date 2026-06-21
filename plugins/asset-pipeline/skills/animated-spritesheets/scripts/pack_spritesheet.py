#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""Pack runtime frames into an engine-loadable **spritesheet** + manifest.

This is the final step the rest of the pipeline was missing: it turns the loose
`runtime/frame-*.png` into ONE packed PNG (uniform grid, exact frame cells, no
labels, no gaps, transparent background) plus a JSON manifest a 2D engine loads
directly. This is NOT build_contact_sheet.py — that one adds labels/gaps/bg for
human review and is not loadable.

Default layout is a single horizontal strip (rows=1), which loads cleanly with
Phaser's `load.spritesheet(key, url, { frameWidth, frameHeight })` +
`anims.generateFrameNumbers(key, { start: 0, end: N-1 })`. Use --columns for a
grid when a strip would be too wide.

Manifest (`spritesheet.json`) matches the repo's asset-index shape:
  { image, frameWidth, frameHeight, columns, rows, frameCount, fps,
    animations: { <action>: { fps, frames: [0..N-1] } } }

Usage:
  pack_spritesheet.py --input-dir runtime --out spritesheet.png --action walk --fps 10
  pack_spritesheet.py --input-dir runtime --out sheet.png --columns 5 --json-out sheet.json
  pack_spritesheet.py --selftest
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from PIL import Image


def pack(
    input_dir: Path,
    out: Path,
    *,
    glob: str = "frame-*.png",
    columns: int | None = None,
    fps: int = 10,
    action: str = "anim",
    json_out: Path | None = None,
) -> dict:
    paths = sorted(input_dir.glob(glob))
    if not paths:
        raise SystemExit(f"no frames matching {glob} in {input_dir}")
    images = [Image.open(p).convert("RGBA") for p in paths]
    sizes = {im.size for im in images}
    if len(sizes) != 1:
        raise SystemExit(
            f"frames are not a uniform size ({sorted(sizes)}); normalize them first "
            "(run normalize_canvas.py)."
        )
    fw, fh = images[0].size
    n = len(images)
    cols = n if columns in (None, 0) else min(columns, n)
    rows = (n + cols - 1) // cols

    sheet = Image.new("RGBA", (cols * fw, rows * fh), (0, 0, 0, 0))
    for i, im in enumerate(images):
        r, c = divmod(i, cols)
        sheet.paste(im, (c * fw, r * fh))  # exact cell, no gap, alpha preserved
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)

    manifest = {
        "image": out.name,
        "frameWidth": fw,
        "frameHeight": fh,
        "columns": cols,
        "rows": rows,
        "frameCount": n,
        "fps": fps,
        "animations": {action: {"fps": fps, "frames": list(range(n))}},
    }
    manifest_path = json_out if json_out is not None else out.with_suffix(".json")
    manifest_path.write_text(json.dumps(manifest, indent=2))
    manifest["_manifestPath"] = str(manifest_path)
    manifest["_sheetPath"] = str(out)
    return manifest


def selftest() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="pack_spritesheet_selftest_"))
    src = tmp / "in"
    src.mkdir()
    colors = [(200, 0, 0), (0, 200, 0), (0, 0, 200), (200, 200, 0), (200, 0, 200), (0, 200, 200)]
    for i, col in enumerate(colors, 1):
        im = Image.new("RGBA", (32, 32), (*col, 255))
        im.save(src / f"frame-{i:02d}.png")

    # strip default: 6 frames -> 6x1
    strip = tmp / "strip.png"
    m = pack(src, strip, fps=12, action="walk")
    img = Image.open(strip)
    assert img.size == (32 * 6, 32), f"strip dims wrong: {img.size}"
    assert m["frameWidth"] == 32 and m["frameHeight"] == 32 and m["frameCount"] == 6
    assert m["columns"] == 6 and m["rows"] == 1 and m["fps"] == 12
    assert m["animations"]["walk"]["frames"] == list(range(6))
    # frame 2 (index 1) cell must be the 2nd colour
    assert img.convert("RGBA").getpixel((32 + 16, 16))[:3] == (0, 200, 0), "frame order/placement wrong"
    # manifest divides cleanly (engine load.spritesheet contract)
    assert img.size[0] % m["frameWidth"] == 0 and img.size[1] % m["frameHeight"] == 0

    # grid: columns=4 -> 4x2 (8 cells, 6 used)
    grid = tmp / "grid.png"
    mg = pack(src, grid, columns=4, fps=10, action="x")
    gi = Image.open(grid)
    assert mg["columns"] == 4 and mg["rows"] == 2
    assert gi.size == (32 * 4, 32 * 2), f"grid dims wrong: {gi.size}"
    # trailing cells (index 6,7) stay transparent
    assert gi.convert("RGBA").getpixel((32 * 2 + 16, 32 + 16))[3] == 0, "unused cell not transparent"

    # non-uniform frames must be rejected
    bad = tmp / "bad"
    bad.mkdir()
    Image.new("RGBA", (32, 32)).save(bad / "frame-01.png")
    Image.new("RGBA", (40, 32)).save(bad / "frame-02.png")
    try:
        pack(bad, tmp / "bad.png")
        raise AssertionError("should have rejected non-uniform frames")
    except SystemExit:
        pass
    print("pack_spritesheet selftest: OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Pack runtime frames into an engine-loadable spritesheet + manifest.")
    ap.add_argument("--input-dir", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--glob", default="frame-*.png")
    ap.add_argument("--columns", type=int, default=None, help="grid columns; default = single horizontal strip")
    ap.add_argument("--fps", type=int, default=10)
    ap.add_argument("--action", default="anim", help="animation name written into the manifest")
    ap.add_argument("--json-out", type=Path, default=None, help="manifest path (default: <out>.json)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not args.input_dir or not args.out:
        ap.error("--input-dir and --out are required (or use --selftest)")
    manifest = pack(args.input_dir, args.out, glob=args.glob, columns=args.columns,
                    fps=args.fps, action=args.action, json_out=args.json_out)
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import argparse
import json
from pathlib import Path
from PIL import Image, ImageColor


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Normalize frame crops onto a fixed canvas with a shared anchor.")
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--glob", default="*.png")
    parser.add_argument("--canvas", default="256x256")
    parser.add_argument("--center-x", type=int, default=128)
    parser.add_argument("--bottom-y", type=int, default=255)
    parser.add_argument("--flat-bg", default=None, help="Optional flat background color for secondary outputs.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    canvas_w, canvas_h = [int(part) for part in args.canvas.lower().split("x", maxsplit=1)]
    args.out_dir.mkdir(parents=True, exist_ok=True)
    flat_dir = args.out_dir / "flat-bg" if args.flat_bg else None
    if flat_dir:
        flat_dir.mkdir(parents=True, exist_ok=True)

    meta = {
        "canvas": [canvas_w, canvas_h],
        "center_x": args.center_x,
        "bottom_y": args.bottom_y,
        "frames": [],
    }
    matched = sorted(args.input_dir.glob(args.glob))
    if not matched:
        raise SystemExit(f"No files matched {args.glob} in {args.input_dir}")

    for src in matched:
        fg = Image.open(src).convert("RGBA")
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        paste_x = int(round(args.center_x - fg.width / 2))
        paste_y = args.bottom_y - fg.height + 1
        canvas.alpha_composite(fg, (paste_x, paste_y))
        out = args.out_dir / src.name
        canvas.save(out)
        if flat_dir:
            flat = Image.new("RGBA", (canvas_w, canvas_h), ImageColor.getrgb(args.flat_bg) + (255,))
            flat.alpha_composite(canvas, (0, 0))
            flat.save(flat_dir / src.name)
        meta["frames"].append({"input": str(src), "output": str(out), "paste_xy": [paste_x, paste_y]})

    (args.out_dir / "normalization-metadata.json").write_text(json.dumps(meta, indent=2))
    print(args.out_dir)


if __name__ == "__main__":
    main()

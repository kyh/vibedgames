#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import argparse
from pathlib import Path
from PIL import Image, ImageColor


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a GIF from a selected frame order.")
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--pattern", default="frame-{id}.png", help="Filename pattern with {id} placeholder.")
    parser.add_argument("--order", required=True, help="Comma-separated frame ids, e.g. 01,03,02,04")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--durations-ms", default=None, help="Optional comma-separated durations matching the order.")
    parser.add_argument("--flat-bg", default=None, help="Optional flat background color.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    order = [part.strip() for part in args.order.split(",") if part.strip()]
    durations = None
    if args.durations_ms:
        durations = [int(part.strip()) for part in args.durations_ms.split(",") if part.strip()]
        if len(durations) != len(order):
            raise SystemExit("durations-ms length must match frame order length")

    frames = []
    for frame_id in order:
        path = args.input_dir / args.pattern.format(id=frame_id)
        img = Image.open(path).convert("RGBA")
        if args.flat_bg:
            flat = Image.new("RGBA", img.size, ImageColor.getrgb(args.flat_bg) + (255,))
            flat.alpha_composite(img, (0, 0))
            img = flat
        frames.append(img.convert("RGB"))

    if not frames:
        raise SystemExit("No frames selected")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        args.out,
        save_all=True,
        append_images=frames[1:],
        duration=durations if durations else 120,
        loop=0,
        optimize=False,
        disposal=2,
    )
    print(args.out)


if __name__ == "__main__":
    main()

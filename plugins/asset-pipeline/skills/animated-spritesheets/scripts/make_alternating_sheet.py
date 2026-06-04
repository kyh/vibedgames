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
    parser = argparse.ArgumentParser(description="Create an alternating-pixel sheet guide PNG.")
    parser.add_argument("--size", required=True, help="Output size, e.g. 512x1280")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--color-a", default="#e8e8e8")
    parser.add_argument("--color-b", default="#d2d2d2")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    width_text, height_text = args.size.lower().split("x", maxsplit=1)
    width = int(width_text)
    height = int(height_text)
    color_a = ImageColor.getrgb(args.color_a)
    color_b = ImageColor.getrgb(args.color_b)

    img = Image.new("RGB", (width, height))
    pix = img.load()
    for y in range(height):
        for x in range(width):
            pix[x, y] = color_a if (x + y) % 2 == 0 else color_b

    args.out.parent.mkdir(parents=True, exist_ok=True)
    img.save(args.out)
    print(args.out)


if __name__ == "__main__":
    main()

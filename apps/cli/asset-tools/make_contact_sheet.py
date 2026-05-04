#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
from pathlib import Path

from _asset_common import image_paths

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:
    raise SystemExit("Pillow is required. Install with: python3 -m pip install Pillow") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a numbered contact sheet.")
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cols", type=int, default=12)
    parser.add_argument("--cell-size", type=int, default=128)
    parser.add_argument("--image-size", type=int, default=112)
    return parser.parse_args()


def fit_image(image: Image.Image, size: int) -> Image.Image:
    frame = image.convert("RGBA")
    frame.thumbnail((size, size), Image.Resampling.LANCZOS)
    return frame


def main() -> None:
    args = parse_args()
    if args.cols <= 0:
        raise SystemExit("--cols must be positive")
    if args.cell_size <= 0 or args.image_size <= 0:
        raise SystemExit("--cell-size and --image-size must be positive")
    if args.image_size > args.cell_size:
        raise SystemExit("--image-size must be <= --cell-size")

    frames = image_paths(args.source_dir)
    if not frames:
        raise SystemExit(f"No image frames found in {args.source_dir}")

    rows = math.ceil(len(frames) / args.cols)
    label_height = 18
    sheet = Image.new(
        "RGBA",
        (args.cols * args.cell_size, rows * (args.cell_size + label_height)),
        (18, 20, 24, 255),
    )
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()

    for index, path in enumerate(frames, start=1):
        with Image.open(path) as opened:
            thumb = fit_image(opened, args.image_size)
        col = (index - 1) % args.cols
        row = (index - 1) // args.cols
        x0 = col * args.cell_size
        y0 = row * (args.cell_size + label_height)
        draw.rectangle(
            (x0, y0, x0 + args.cell_size - 1, y0 + args.cell_size + label_height - 1),
            outline=(64, 70, 82, 255),
            fill=(28, 32, 38, 255),
        )
        x = x0 + (args.cell_size - thumb.width) // 2
        y = y0 + (args.cell_size - thumb.height) // 2
        sheet.alpha_composite(thumb, (x, y))
        label = str(index)
        draw.rectangle((x0, y0, x0 + 32, y0 + 14), fill=(0, 0, 0, 180))
        draw.text((x0 + 4, y0 + 2), label, font=font, fill=(255, 255, 255, 255))
        draw.text((x0 + 4, y0 + args.cell_size + 2), path.name, font=font, fill=(210, 216, 226, 255))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.output)
    print(args.output)


if __name__ == "__main__":
    main()

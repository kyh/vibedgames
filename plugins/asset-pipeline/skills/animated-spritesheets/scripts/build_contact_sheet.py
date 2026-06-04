#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a labeled contact sheet from frame PNGs.")
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--glob", default="*.png")
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--cols", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--labels-json", type=Path, default=None, help="Optional JSON array of label strings.")
    parser.add_argument("--bg", default="#f0f0f0")
    parser.add_argument("--sheet-bg", default="#111111")
    parser.add_argument("--label-bg", default="#181818")
    parser.add_argument("--font-size", type=int, default=18)
    parser.add_argument("--gap", type=int, default=12)
    parser.add_argument("--label-height", type=int, default=44)
    parser.add_argument("--font-path", default="/System/Library/Fonts/Supplemental/Verdana Bold.ttf")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    frames = sorted(args.input_dir.glob(args.glob))
    if not frames:
        raise SystemExit(f"No frames matched {args.glob} in {args.input_dir}")

    labels = [p.stem for p in frames]
    if args.labels_json:
        labels = json.loads(args.labels_json.read_text())
        if len(labels) != len(frames):
            raise SystemExit("labels-json length must match frame count")

    first = Image.open(frames[0]).convert("RGBA")
    frame_w, frame_h = first.size
    font = ImageFont.truetype(args.font_path, args.font_size)
    sheet = Image.new(
        "RGBA",
        (
            args.cols * (frame_w + args.gap) + args.gap,
            args.rows * (frame_h + args.label_height + args.gap) + args.gap,
        ),
        args.sheet_bg,
    )

    for i, (frame_path, label) in enumerate(zip(frames, labels)):
        sprite = Image.open(frame_path).convert("RGBA")
        flat = Image.new("RGBA", (frame_w, frame_h), args.bg)
        flat.alpha_composite(sprite, (0, 0))
        tile = Image.new("RGBA", (frame_w, frame_h + args.label_height), args.sheet_bg)
        tile.alpha_composite(flat, (0, 0))
        draw = ImageDraw.Draw(tile)
        draw.rectangle((0, frame_h, frame_w, frame_h + args.label_height), fill=args.label_bg)
        bbox = draw.textbbox((0, 0), label, font=font)
        text_x = (frame_w - (bbox[2] - bbox[0])) // 2
        text_y = frame_h + (args.label_height - (bbox[3] - bbox[1])) // 2 - 1
        draw.text((text_x, text_y), label, fill="white", font=font)
        col = i % args.cols
        row = i // args.cols
        sheet.alpha_composite(
            tile,
            (args.gap + col * (frame_w + args.gap), args.gap + row * (frame_h + args.label_height + args.gap)),
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.out)
    print(args.out)


if __name__ == "__main__":
    main()

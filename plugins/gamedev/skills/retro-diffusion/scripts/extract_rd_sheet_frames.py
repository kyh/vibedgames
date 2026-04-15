#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract labeled frames from a Retro Diffusion spritesheet.")
    parser.add_argument("sheet", type=Path, help="Input spritesheet PNG.")
    parser.add_argument("--frame", default="64x64", help="Frame size WxH.")
    parser.add_argument("--out-dir", type=Path, required=True, help="Output directory.")
    parser.add_argument("--prefix", required=True, help="Output filename prefix.")
    return parser.parse_args()


def parse_frame(text: str) -> tuple[int, int]:
    w_str, h_str = text.lower().split("x", maxsplit=1)
    return int(w_str), int(h_str)


def rms_diff(a: Image.Image, b: Image.Image) -> float:
    diff = ImageChops.difference(a.convert("RGBA"), b.convert("RGBA"))
    hist = diff.histogram()
    sq = 0.0
    total = a.width * a.height * 4
    for idx, count in enumerate(hist):
        value = idx % 256
        sq += count * (value * value)
    return math.sqrt(sq / total)


def main() -> None:
    args = parse_args()
    frame_w, frame_h = parse_frame(args.frame)
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    sheet = Image.open(args.sheet).convert("RGBA")
    if sheet.width % frame_w != 0 or sheet.height % frame_h != 0:
        raise SystemExit(f"Sheet size {sheet.width}x{sheet.height} not divisible by {frame_w}x{frame_h}")

    cols = sheet.width // frame_w
    rows = sheet.height // frame_h

    frames: list[Image.Image] = []
    frame_paths: list[str] = []
    for row in range(rows):
        for col in range(cols):
            index = row * cols + col + 1
            crop = sheet.crop((col * frame_w, row * frame_h, (col + 1) * frame_w, (row + 1) * frame_h))
            frame_path = out_dir / f"{args.prefix}-frame-{index:02d}.png"
            crop.save(frame_path)
            frames.append(crop)
            frame_paths.append(str(frame_path))

    font = ImageFont.load_default()
    margin = 12
    label_h = 14
    contact = Image.new("RGBA", (cols * (frame_w + margin) + margin, rows * (frame_h + label_h + margin) + margin), (15, 18, 24, 255))
    draw = ImageDraw.Draw(contact)
    for row in range(rows):
        for col in range(cols):
            index = row * cols + col
            x = margin + col * (frame_w + margin)
            y = margin + row * (frame_h + label_h + margin)
            draw.rounded_rectangle((x - 2, y - 2, x + frame_w + 2, y + frame_h + label_h + 2), radius=6, fill=(28, 33, 44, 255))
            contact.alpha_composite(frames[index], (x, y))
            draw.text((x + 3, y + frame_h + 1), f"{index+1:02d}", font=font, fill=(240, 240, 240, 255))

    contact_path = out_dir / f"{args.prefix}-contact-sheet.png"
    contact.save(contact_path)

    diffs = []
    for i in range(len(frames)):
        j = (i + 1) % len(frames)
        diffs.append({
            "from": i + 1,
            "to": j + 1,
            "rms_diff": round(rms_diff(frames[i], frames[j]), 4),
        })

    manifest = {
        "sheet": str(args.sheet.resolve()),
        "frame_size": {"w": frame_w, "h": frame_h},
        "grid": {"cols": cols, "rows": rows},
        "frames": frame_paths,
        "contact_sheet": str(contact_path),
        "adjacent_rms_diff": diffs,
    }
    (out_dir / f"{args.prefix}-frames.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

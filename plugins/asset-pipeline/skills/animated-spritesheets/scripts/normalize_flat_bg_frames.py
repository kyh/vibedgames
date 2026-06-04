#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path

from PIL import Image, ImageColor


def parse_size(value: str) -> tuple[int, int]:
    width, height = value.lower().split("x", maxsplit=1)
    return int(width), int(height)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Remove a connected flat background from frame crops, then normalize "
            "the detected foreground onto a shared canvas anchor."
        )
    )
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--glob", default="*.png")
    parser.add_argument("--canvas", default="256x256")
    parser.add_argument("--center-x", type=int, default=128)
    parser.add_argument("--bottom-y", type=int, default=255)
    parser.add_argument("--threshold", type=float, default=32.0)
    parser.add_argument("--flat-bg", default=None, help="Optional review background color.")
    return parser.parse_args()


def color_distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return sum((a[i] - b[i]) ** 2 for i in range(3)) ** 0.5


def foreground_crop(
    src: Image.Image,
    threshold: float,
) -> tuple[Image.Image, dict[str, object]]:
    image = src.convert("RGBA")
    width, height = image.size
    pixels = image.load()
    corners = [
        pixels[0, 0][:3],
        pixels[width - 1, 0][:3],
        pixels[0, height - 1][:3],
        pixels[width - 1, height - 1][:3],
    ]
    bg = tuple(sum(c[i] for c in corners) // len(corners) for i in range(3))

    queue: deque[tuple[int, int]] = deque(
        [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]
    )
    seen: set[tuple[int, int]] = set()
    background: set[tuple[int, int]] = set()

    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= width or y >= height or (x, y) in seen:
            continue
        seen.add((x, y))
        if color_distance(pixels[x, y][:3], bg) <= threshold:
            background.add((x, y))
            queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

    xs: list[int] = []
    ys: list[int] = []
    for y in range(height):
        for x in range(width):
            if (x, y) in background:
                pixels[x, y] = (0, 0, 0, 0)
            elif pixels[x, y][3] > 0:
                xs.append(x)
                ys.append(y)

    if not xs:
        raise ValueError("No foreground detected after flat background removal")

    bbox = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
    return image.crop(bbox), {"background_rgb": bg, "bbox": bbox}


def main() -> None:
    args = parse_args()
    canvas_w, canvas_h = parse_size(args.canvas)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    flat_dir = args.out_dir / "flat-bg" if args.flat_bg else None
    if flat_dir:
        flat_dir.mkdir(parents=True, exist_ok=True)

    matched = sorted(args.input_dir.glob(args.glob))
    if not matched:
        raise SystemExit(f"No files matched {args.glob} in {args.input_dir}")

    meta = {
        "canvas": [canvas_w, canvas_h],
        "center_x": args.center_x,
        "bottom_y": args.bottom_y,
        "threshold": args.threshold,
        "frames": [],
    }

    for src in matched:
        crop, crop_meta = foreground_crop(Image.open(src), args.threshold)
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        paste_x = round(args.center_x - crop.width / 2)
        paste_y = args.bottom_y - crop.height + 1
        canvas.alpha_composite(crop, (paste_x, paste_y))
        out = args.out_dir / src.name
        canvas.save(out)

        if flat_dir:
            flat = Image.new("RGBA", (canvas_w, canvas_h), ImageColor.getrgb(args.flat_bg) + (255,))
            flat.alpha_composite(canvas, (0, 0))
            flat.save(flat_dir / src.name)

        meta["frames"].append(
            {
                "input": str(src),
                "output": str(out),
                "source_background_rgb": crop_meta["background_rgb"],
                "source_bbox": crop_meta["bbox"],
                "crop_size": [crop.width, crop.height],
                "paste_xy": [paste_x, paste_y],
            }
        )

    (args.out_dir / "normalization-metadata.json").write_text(json.dumps(meta, indent=2))
    print(args.out_dir)


if __name__ == "__main__":
    main()

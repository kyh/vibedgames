#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from _asset_common import RASTER_EXTENSIONS, image_paths

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit("Pillow is required. Install with: python3 -m pip install Pillow") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Remove a light solid-ish background from frames.")
    parser.add_argument("--source-frames-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--frame-prefix", required=True)
    parser.add_argument("--tolerance", type=int, default=34)
    parser.add_argument("--softness", type=int, default=22)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def estimate_background(image: Image.Image) -> tuple[int, int, int]:
    rgb = image.convert("RGB")
    samples: list[tuple[int, int, int]] = []
    width, height = rgb.size
    pixels = rgb.load()
    for x, y in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
        samples.append(pixels[x, y])
    border_step = max(1, min(width, height) // 32)
    for x in range(0, width, border_step):
        samples.append(pixels[x, 0])
        samples.append(pixels[x, height - 1])
    for y in range(0, height, border_step):
        samples.append(pixels[0, y])
        samples.append(pixels[width - 1, y])
    count = len(samples)
    return (
        round(sum(color[0] for color in samples) / count),
        round(sum(color[1] for color in samples) / count),
        round(sum(color[2] for color in samples) / count),
    )


def color_distance(left: tuple[int, int, int], right: tuple[int, int, int]) -> float:
    return (
        (left[0] - right[0]) ** 2
        + (left[1] - right[1]) ** 2
        + (left[2] - right[2]) ** 2
    ) ** 0.5


def matte(image: Image.Image, bg: tuple[int, int, int], tolerance: int, softness: int) -> tuple[Image.Image, int]:
    out = image.convert("RGBA")
    pixels = out.load()
    removed = 0
    width, height = out.size
    soft_end = max(tolerance + 1, tolerance + softness)
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            dist = color_distance((r, g, b), bg)
            if dist <= tolerance:
                pixels[x, y] = (r, g, b, 0)
                removed += 1
            elif dist < soft_end:
                keep = (dist - tolerance) / (soft_end - tolerance)
                pixels[x, y] = (r, g, b, round(a * keep))
                removed += 1
    return out, removed


def main() -> None:
    args = parse_args()
    frames = image_paths(args.source_frames_dir, RASTER_EXTENSIONS)
    if not frames:
        raise SystemExit(f"No source frames found in {args.source_frames_dir}")
    if args.output_dir.exists():
        existing = [path for path in args.output_dir.iterdir() if path.is_file()]
        if existing and not args.overwrite:
            raise SystemExit(f"Output directory is not empty: {args.output_dir}. Pass --overwrite.")
        if args.overwrite:
            for path in existing:
                path.unlink()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []
    frame_reports = []
    for index, path in enumerate(frames, start=1):
        with Image.open(path) as opened:
            source = opened.convert("RGBA")
        bg = estimate_background(source)
        matted, removed = matte(source, bg, args.tolerance, args.softness)
        total = source.width * source.height
        removed_ratio = removed / total
        if removed_ratio > 0.75:
            warnings.append(f"Frame {index} removed {removed_ratio:.1%} of pixels")
        output = args.output_dir / f"{args.frame_prefix}_{index:04d}.png"
        matted.save(output)
        frame_reports.append(
            {
                "index": index,
                "source": path.name,
                "output": output.name,
                "estimated_background": list(bg),
                "removed_pixel_ratio": round(removed_ratio, 6),
            }
        )

    report = {
        "source_dir": str(args.source_frames_dir.resolve()),
        "output_dir": str(args.output_dir.resolve()),
        "frame_count": len(frames),
        "tolerance": args.tolerance,
        "softness": args.softness,
        "warnings": warnings,
        "frames": frame_reports,
    }
    report_path = args.output_dir / "matte_report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(report_path)


if __name__ == "__main__":
    main()

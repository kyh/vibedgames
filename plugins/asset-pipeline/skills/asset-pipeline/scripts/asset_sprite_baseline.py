#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Audit and optionally normalize visible sprite baselines inside spritesheet frames.

Examples:
  uv run scripts/asset_sprite_baseline.py public/assets/kaede --frame 256x256
  uv run scripts/asset_sprite_baseline.py public/assets/kaede/attack-n.png --frame 256x256 --target-bottom 255 --out fixed/attack-n.png
  uv run scripts/asset_sprite_baseline.py public/assets/kaede --frame 256x256 --target-bottom 255 --out-dir fixed/kaede --json tmp/baselines.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def parse_frame(text: str) -> tuple[int, int]:
    try:
        w_str, h_str = text.lower().split("x", maxsplit=1)
        return int(w_str), int(h_str)
    except Exception as exc:  # noqa: BLE001
        raise argparse.ArgumentTypeError("frame must be WxH, e.g. 256x256") from exc


def iter_targets(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    return sorted(path.rglob("*.png"))


def paste_shifted(frame: Image.Image, dx: int, dy: int) -> Image.Image:
    out = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    # paste clips automatically when shifted outside the destination bounds.
    out.paste(frame, (dx, dy), frame)
    return out


def analyze_and_fix(
    path: Path,
    frame_w: int,
    frame_h: int,
    target_bottom: int,
    target_center_x: int | None,
    out_path: Path | None,
) -> dict[str, object]:
    img = Image.open(path).convert("RGBA")
    width, height = img.size

    if width % frame_w != 0 or height % frame_h != 0:
        raise ValueError(f"{path} size {width}x{height} not divisible by {frame_w}x{frame_h}")

    columns = width // frame_w
    rows = height // frame_h
    fixed = Image.new("RGBA", img.size, (0, 0, 0, 0)) if out_path else None
    frames: list[dict[str, object]] = []

    for row in range(rows):
        for col in range(columns):
            left = col * frame_w
            top = row * frame_h
            frame = img.crop((left, top, left + frame_w, top + frame_h))
            alpha_bbox = frame.getchannel("A").getbbox()

            if alpha_bbox is None:
                frame_record: dict[str, object] = {
                    "index": row * columns + col,
                    "col": col,
                    "row": row,
                    "empty": True,
                }
                shifted = frame
            else:
                x0, y0, x1, y1 = alpha_bbox
                bottom_y = y1 - 1
                center_x = (x0 + x1 - 1) / 2
                shift_y = target_bottom - bottom_y
                shift_x = 0 if target_center_x is None else int(round(target_center_x - center_x))

                frame_record = {
                    "index": row * columns + col,
                    "col": col,
                    "row": row,
                    "empty": False,
                    "alphaBBox": [x0, y0, x1, y1],
                    "visibleBottomY": bottom_y,
                    "visibleCenterX": center_x,
                    "shiftToTarget": [shift_x, shift_y],
                }
                shifted = paste_shifted(frame, shift_x, shift_y)

            frames.append(frame_record)
            if fixed is not None:
                fixed.alpha_composite(shifted, (left, top))

    if out_path and fixed is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        fixed.save(out_path)

    non_empty = [frame for frame in frames if not frame.get("empty")]
    bottom_values = [int(frame["visibleBottomY"]) for frame in non_empty]
    shift_values = [frame["shiftToTarget"][1] for frame in non_empty]  # type: ignore[index]

    return {
        "path": str(path),
        "size": {"width": width, "height": height},
        "frame": {"width": frame_w, "height": frame_h},
        "grid": {"columns": columns, "rows": rows},
        "targetBottomY": target_bottom,
        "targetCenterX": target_center_x,
        "visibleBottomYRange": [min(bottom_values), max(bottom_values)] if bottom_values else None,
        "shiftYRange": [min(shift_values), max(shift_values)] if shift_values else None,
        "out": str(out_path) if out_path else None,
        "frames": frames,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Audit and optionally normalize visible sprite baselines in PNG spritesheets."
    )
    parser.add_argument("path", type=Path, help="PNG file or folder.")
    parser.add_argument("--frame", type=parse_frame, required=True, help="Frame size WxH.")
    parser.add_argument(
        "--target-bottom",
        type=int,
        default=None,
        help="Target visible bottom pixel, inclusive. Defaults to frame height - 1.",
    )
    parser.add_argument(
        "--target-center-x",
        type=int,
        default=None,
        help="Optional target visible center x. Omit to only normalize the vertical baseline.",
    )
    parser.add_argument("--out", type=Path, default=None, help="Fixed output PNG for single-file input.")
    parser.add_argument("--out-dir", type=Path, default=None, help="Fixed output folder for file/folder input.")
    parser.add_argument("--json", type=Path, default=None, help="Optional JSON report path.")
    args = parser.parse_args()

    frame_w, frame_h = args.frame
    target_bottom = frame_h - 1 if args.target_bottom is None else args.target_bottom
    targets = iter_targets(args.path)

    if not targets:
        raise SystemExit(f"No PNG files found in {args.path}")
    if args.out and len(targets) != 1:
        raise SystemExit("--out can only be used with a single PNG input; use --out-dir for folders.")
    if args.out and args.out_dir:
        raise SystemExit("Use either --out or --out-dir, not both.")

    reports: list[dict[str, object]] = []
    for target in targets:
        out_path: Path | None = None
        if args.out:
            out_path = args.out
        elif args.out_dir:
            rel = target.name if args.path.is_file() else target.relative_to(args.path)
            out_path = args.out_dir / rel

        report = analyze_and_fix(
            target,
            frame_w,
            frame_h,
            target_bottom,
            args.target_center_x,
            out_path,
        )
        reports.append(report)
        print(
            f"{target} frame={frame_w}x{frame_h} "
            f"bottom_range={report['visibleBottomYRange']} shift_y_range={report['shiftYRange']}"
        )

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(reports, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

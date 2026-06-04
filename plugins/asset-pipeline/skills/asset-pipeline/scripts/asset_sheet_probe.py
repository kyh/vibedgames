# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Analyze sprite-sheet grids and list non-empty frames.

Examples:
  uv run path/to/asset_sheet_probe.py path/to/sheet.png --frame 32x32 --list
  uv run path/to/asset_sheet_probe.py path/to/folder --frame 16x16 --list --json tmp/probe.json
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image


@dataclass(frozen=True)
class GridInfo:
    columns: int
    rows: int
    non_empty: list[tuple[int, int]]


def parse_frame(text: str) -> tuple[int, int]:
    # Accept "WxH" formats like "32x32".
    try:
        w_str, h_str = text.lower().split("x", maxsplit=1)
        return int(w_str), int(h_str)
    except Exception as exc:  # noqa: BLE001
        raise argparse.ArgumentTypeError("frame must be WxH, e.g., 32x32") from exc


def iter_targets(path: Path) -> Iterable[Path]:
    if path.is_file():
        return [path]
    return sorted(path.rglob("*.png"))


def analyze_grid(path: Path, frame_w: int, frame_h: int) -> GridInfo:
    with Image.open(path) as img:
        img = img.convert("RGBA")
        alpha = img.getchannel("A")
        width, height = img.size

        if width % frame_w != 0 or height % frame_h != 0:
            raise ValueError(
                f"{path} size {width}x{height} not divisible by {frame_w}x{frame_h}"
            )

        cols = width // frame_w
        rows = height // frame_h
        non_empty: list[tuple[int, int]] = []

        for row in range(rows):
            for col in range(cols):
                cell = alpha.crop(
                    (col * frame_w, row * frame_h, (col + 1) * frame_w, (row + 1) * frame_h)
                )
                if cell.getbbox() is not None:
                    non_empty.append((col, row))

        return GridInfo(columns=cols, rows=rows, non_empty=non_empty)


def main() -> None:
    parser = argparse.ArgumentParser(description="Probe sprite-sheet grids.")
    parser.add_argument("path", type=Path, help="PNG file or folder.")
    parser.add_argument("--frame", type=parse_frame, required=True, help="Frame size WxH.")
    parser.add_argument(
        "--list",
        action="store_true",
        help="List non-empty frame coordinates.",
    )
    parser.add_argument(
        "--show-empty",
        action="store_true",
        help="Also list empty frame coordinates.",
    )
    parser.add_argument(
        "--json",
        type=Path,
        default=None,
        help="Optional JSON output path.",
    )
    args = parser.parse_args()

    frame_w, frame_h = args.frame

    results: list[dict[str, object]] = []
    for target in iter_targets(args.path):
        info = analyze_grid(target, frame_w, frame_h)
        total = info.columns * info.rows
        empty_count = total - len(info.non_empty)
        print(
            f"{target}  grid={info.columns}x{info.rows}  non_empty={len(info.non_empty)}  empty={empty_count}"
        )

        if args.list or args.show_empty:
            non_set = set(info.non_empty)
            if args.list:
                print(f"  non_empty={sorted(non_set)}")
            if args.show_empty:
                empties = [
                    (c, r)
                    for r in range(info.rows)
                    for c in range(info.columns)
                    if (c, r) not in non_set
                ]
                print(f"  empty={empties}")

        # Collect JSON-ready data for cross-engine use.
        result: dict[str, object] = {
            "path": str(target),
            "frame": {"w": frame_w, "h": frame_h},
            "grid": {"columns": info.columns, "rows": info.rows},
            "non_empty": sorted(info.non_empty),
            "empty_count": empty_count,
        }
        if args.show_empty:
            non_set = set(info.non_empty)
            result["empty"] = [
                (c, r)
                for r in range(info.rows)
                for c in range(info.columns)
                if (c, r) not in non_set
            ]
        results.append(result)

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        with args.json.open("w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)


if __name__ == "__main__":
    main()

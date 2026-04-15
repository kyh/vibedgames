# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
List image dimensions for asset PNGs.

Usage:
  uv run path/to/asset_sizes.py
  uv run path/to/asset_sizes.py --root assets --json tmp/sizes.json
  uv run path/to/asset_sizes.py --root path/to/assets --csv tmp/sizes.csv
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Iterable

from PIL import Image


def iter_pngs(root: Path) -> Iterable[Path]:
    # Walk the tree once and return sorted PNG paths.
    return sorted(root.rglob("*.png"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Print PNG sizes for a folder tree.")
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Root folder to scan (default: ./assets if it exists else .).",
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Optional CSV output path.",
    )
    parser.add_argument(
        "--json",
        type=Path,
        default=None,
        help="Optional JSON output path.",
    )
    args = parser.parse_args()

    root: Path = args.root if args.root is not None else (Path("assets") if Path("assets").exists() else Path("."))
    if not root.exists():
        raise SystemExit(f"Root not found: {root}")

    rows: list[tuple[int, int, str]] = []
    for path in iter_pngs(root):
        with Image.open(path) as img:
            w, h = img.size
        rows.append((w, h, str(path)))

    # Default to console output; optionally also write CSV/JSON.
    for w, h, path in rows:
        print(f"{w}x{h}\t{path}")

    if args.csv:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        with args.csv.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["width", "height", "path"])
            writer.writerows(rows)

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        payload = [{"width": w, "height": h, "path": path} for w, h, path in rows]
        with args.json.open("w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)


if __name__ == "__main__":
    main()

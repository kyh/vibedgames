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
from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Recover frame crops from a full generated spritesheet by connected components.")
    parser.add_argument("sheet", type=Path)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--cols", type=int, required=True)
    parser.add_argument("--threshold", type=int, default=15, help="Color-distance threshold from sampled background.")
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--prefix", default="frame")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    img = Image.open(args.sheet).convert("RGBA")
    width, height = img.size
    px = img.load()

    corners = [px[0, 0][:3], px[width - 1, 0][:3], px[0, height - 1][:3], px[width - 1, height - 1][:3]]
    bg = tuple(round(sum(c[i] for c in corners) / len(corners)) for i in range(3))

    mask = [[False] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            r, g, b, _ = px[x, y]
            dist = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])
            mask[y][x] = dist > args.threshold

    seen = [[False] * width for _ in range(height)]
    components: list[dict[str, object]] = []
    for y in range(height):
        for x in range(width):
            if seen[y][x] or not mask[y][x]:
                continue
            q = deque([(x, y)])
            seen[y][x] = True
            points: list[tuple[int, int]] = []
            minx = maxx = x
            miny = maxy = y
            while q:
                cx, cy = q.popleft()
                points.append((cx, cy))
                minx = min(minx, cx)
                maxx = max(maxx, cx)
                miny = min(miny, cy)
                maxy = max(maxy, cy)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < width and 0 <= ny < height and not seen[ny][nx] and mask[ny][nx]:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            components.append(
                {
                    "area": len(points),
                    "bbox": [minx, miny, maxx, maxy],
                    "center": [(minx + maxx) / 2, (miny + maxy) / 2],
                    "points": points,
                }
            )

    wanted = args.rows * args.cols
    components.sort(key=lambda item: int(item["area"]), reverse=True)
    selected = components[:wanted]
    assigned: list[dict[str, object] | None] = [None] * wanted

    cell_w = width / args.cols
    cell_h = height / args.rows
    for comp in selected:
        cx, cy = comp["center"]  # type: ignore[misc]
        col = min(args.cols - 1, max(0, int(cx // cell_w)))
        row = min(args.rows - 1, max(0, int(cy // cell_h)))
        idx = row * args.cols + col
        current = assigned[idx]
        if current is None or int(comp["area"]) > int(current["area"]):
            assigned[idx] = comp

    missing = [i + 1 for i, item in enumerate(assigned) if item is None]
    if missing:
        raise SystemExit(f"Missing recovered frames for grid slots: {missing}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    metadata = {
        "sheet": str(args.sheet),
        "bg_rgb": bg,
        "rows": args.rows,
        "cols": args.cols,
        "threshold": args.threshold,
        "frames": [],
    }

    for index, comp in enumerate(assigned, start=1):
        assert comp is not None
        minx, miny, maxx, maxy = comp["bbox"]  # type: ignore[misc]
        crop = Image.new("RGBA", (maxx - minx + 1, maxy - miny + 1), (0, 0, 0, 0))
        crop_px = crop.load()
        for x, y in comp["points"]:  # type: ignore[misc]
            crop_px[x - minx, y - miny] = px[x, y]
        out_path = args.out_dir / f"{args.prefix}-{index:02d}.png"
        crop.save(out_path)
        metadata["frames"].append(
            {
                "frame": f"{index:02d}",
                "bbox": comp["bbox"],
                "area": comp["area"],
                "center": comp["center"],
                "path": str(out_path),
            }
        )

    (args.out_dir / f"{args.prefix}-metadata.json").write_text(json.dumps(metadata, indent=2))
    print(args.out_dir)


if __name__ == "__main__":
    main()

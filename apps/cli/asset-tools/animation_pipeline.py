#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from collections import deque
from pathlib import Path
from typing import NamedTuple

from _asset_common import image_paths

try:
    from PIL import Image, ImageDraw
except ImportError as exc:
    raise SystemExit("Pillow is required. Install with: python3 -m pip install Pillow") from exc


class Rect(NamedTuple):
    x0: int
    y0: int
    x1: int
    y1: int


class Placement(NamedTuple):
    scale: float
    scaled_width: int
    scaled_height: int
    paste_x: int
    paste_y: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build transparent 256px sprite cells and a horizontal sprite strip."
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--source-frames-dir", type=Path)
    source.add_argument("--source", type=Path)
    parser.add_argument("--frames", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--preview", required=True, type=Path)
    parser.add_argument("--frames-dir", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--background-mode", choices=["chroma", "alpha"], default="chroma")
    parser.add_argument(
        "--layout-mode", choices=["preserve-canvas", "fit-foreground"], default="preserve-canvas"
    )
    parser.add_argument("--frame-prefix", required=True)
    parser.add_argument("--frame-size", type=int, default=256)
    parser.add_argument("--chroma-key", default="#00FF00")
    parser.add_argument("--chroma-tolerance", type=int, default=16)
    parser.add_argument("--min-component-pixels", type=int, default=3)
    parser.add_argument("--clear-rect", default=None, help="x0,y0,x1,y1 inside final cells")
    parser.add_argument("--resample", choices=["lanczos", "nearest"], default="lanczos")
    return parser.parse_args()


def parse_hex_color(raw: str) -> tuple[int, int, int]:
    value = raw.strip()
    if value.startswith("#"):
        value = value[1:]
    if len(value) != 6:
        raise SystemExit("--chroma-key must be a 6-digit hex color")
    try:
        return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    except ValueError as exc:
        raise SystemExit("--chroma-key must be a 6-digit hex color") from exc


def parse_rect(raw: str | None, frame_size: int) -> Rect | None:
    if raw is None or raw.strip() == "":
        return None
    parts = [piece.strip() for piece in raw.split(",")]
    if len(parts) != 4:
        raise SystemExit("--clear-rect must be x0,y0,x1,y1")
    try:
        x0, y0, x1, y1 = [int(part) for part in parts]
    except ValueError as exc:
        raise SystemExit("--clear-rect must contain integers") from exc
    if x0 < 0 or y0 < 0 or x1 > frame_size or y1 > frame_size or x0 >= x1 or y0 >= y1:
        raise SystemExit("--clear-rect must fit inside the output cell")
    return Rect(x0, y0, x1, y1)


def load_frames_from_dir(source_dir: Path) -> tuple[list[Image.Image], list[str]]:
    paths = image_paths(source_dir)
    if not paths:
        raise SystemExit(f"No source frames found in {source_dir}")
    frames: list[Image.Image] = []
    names: list[str] = []
    for path in paths:
        with Image.open(path) as opened:
            frames.append(opened.convert("RGBA"))
        names.append(path.name)
    return frames, names


def load_frames_from_sheet(source: Path, count: int) -> tuple[list[Image.Image], list[str]]:
    with Image.open(source) as opened:
        sheet = opened.convert("RGBA")
    if sheet.width % count != 0:
        raise SystemExit(f"Source sheet width {sheet.width} is not divisible by --frames {count}")
    frame_width = sheet.width // count
    frames = []
    names = []
    for index in range(count):
        crop = sheet.crop((index * frame_width, 0, (index + 1) * frame_width, sheet.height))
        frames.append(crop)
        names.append(f"{source.name}:{index + 1}")
    return frames, names


def chroma_removed(
    image: Image.Image, key: tuple[int, int, int], tolerance: int
) -> Image.Image:
    out = image.convert("RGBA")
    pixels = out.load()
    key_r, key_g, key_b = key
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            close = (
                abs(r - key_r) <= tolerance
                and abs(g - key_g) <= tolerance
                and abs(b - key_b) <= tolerance
            )
            strong_green = g >= 180 and r <= 95 and b <= 95 and g - max(r, b) >= 80
            if close or strong_green:
                pixels[x, y] = (r, g, b, 0)
                continue
            spill = g >= 120 and r <= 150 and b <= 150 and g - max(r, b) >= 55
            if spill:
                cap = max(r, b) + 18
                pixels[x, y] = (r, min(g, cap), b, a)
    return out


def remove_tiny_components(image: Image.Image, min_pixels: int) -> Image.Image:
    if min_pixels <= 0:
        return image
    out = image.copy()
    alpha = out.getchannel("A")
    pixels = alpha.load()
    width, height = out.size
    visited = bytearray(width * height)
    remove: list[tuple[int, int]] = []
    for y in range(height):
        for x in range(width):
            offset = y * width + x
            if visited[offset] or pixels[x, y] == 0:
                continue
            component: list[tuple[int, int]] = []
            queue: deque[tuple[int, int]] = deque([(x, y)])
            visited[offset] = 1
            while queue:
                cx, cy = queue.popleft()
                component.append((cx, cy))
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    n_offset = ny * width + nx
                    if visited[n_offset] or pixels[nx, ny] == 0:
                        continue
                    visited[n_offset] = 1
                    queue.append((nx, ny))
            if len(component) <= min_pixels:
                remove.extend(component)
    if remove:
        alpha_pixels = alpha.load()
        for x, y in remove:
            alpha_pixels[x, y] = 0
        out.putalpha(alpha)
    return out


def foreground_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = image.getchannel("A")
    return alpha.getbbox()


def edge_alpha_count(image: Image.Image) -> int:
    alpha = image.getchannel("A")
    pixels = alpha.load()
    width, height = image.size
    count = 0
    for x in range(width):
        if pixels[x, 0] > 0:
            count += 1
        if height > 1 and pixels[x, height - 1] > 0:
            count += 1
    for y in range(1, max(1, height - 1)):
        if pixels[0, y] > 0:
            count += 1
        if width > 1 and pixels[width - 1, y] > 0:
            count += 1
    return count


def resample_filter(name: str) -> int:
    if name == "nearest":
        return Image.Resampling.NEAREST
    return Image.Resampling.LANCZOS


def preserve_canvas_cell(image: Image.Image, frame_size: int, resample: int) -> tuple[Image.Image, Placement]:
    scale = min(frame_size / image.width, frame_size / image.height)
    scaled_width = max(1, round(image.width * scale))
    scaled_height = max(1, round(image.height * scale))
    resized = image.resize((scaled_width, scaled_height), resample)
    paste_x = (frame_size - scaled_width) // 2
    paste_y = (frame_size - scaled_height) // 2
    cell = Image.new("RGBA", (frame_size, frame_size), (0, 0, 0, 0))
    cell.alpha_composite(resized, (paste_x, paste_y))
    return cell, Placement(scale, scaled_width, scaled_height, paste_x, paste_y)


def fit_foreground_cell(image: Image.Image, frame_size: int, resample: int) -> tuple[Image.Image, Placement]:
    bbox = foreground_bbox(image)
    if bbox is None:
        return Image.new("RGBA", (frame_size, frame_size), (0, 0, 0, 0)), Placement(1, 0, 0, 0, 0)
    crop = image.crop(bbox)
    target = max(1, frame_size - 24)
    scale = min(target / crop.width, target / crop.height)
    scaled_width = max(1, round(crop.width * scale))
    scaled_height = max(1, round(crop.height * scale))
    resized = crop.resize((scaled_width, scaled_height), resample)
    paste_x = (frame_size - scaled_width) // 2
    paste_y = (frame_size - scaled_height) // 2
    cell = Image.new("RGBA", (frame_size, frame_size), (0, 0, 0, 0))
    cell.alpha_composite(resized, (paste_x, paste_y))
    return cell, Placement(scale, scaled_width, scaled_height, paste_x, paste_y)


def apply_clear_rect(image: Image.Image, rect: Rect | None) -> Image.Image:
    if rect is None:
        return image
    out = image.copy()
    draw = ImageDraw.Draw(out)
    draw.rectangle((rect.x0, rect.y0, rect.x1, rect.y1), fill=(0, 0, 0, 0))
    return out


def alpha_diff_ratio(left: Image.Image, right: Image.Image) -> float:
    left_alpha = left.getchannel("A")
    right_alpha = right.getchannel("A")
    width, height = left.size
    left_pixels = left_alpha.load()
    right_pixels = right_alpha.load()
    changed = 0
    for y in range(height):
        for x in range(width):
            if (left_pixels[x, y] > 0) != (right_pixels[x, y] > 0):
                changed += 1
    return changed / (width * height)


def bbox_record(bbox: tuple[int, int, int, int] | None) -> dict[str, int] | None:
    if bbox is None:
        return None
    x0, y0, x1, y1 = bbox
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "width": x1 - x0, "height": y1 - y0}


def make_checker(size: tuple[int, int], tile: int = 16) -> Image.Image:
    width, height = size
    checker = Image.new("RGBA", size, (0, 0, 0, 255))
    draw = ImageDraw.Draw(checker)
    colors = ((42, 46, 54, 255), (72, 78, 90, 255))
    for y in range(0, height, tile):
        for x in range(0, width, tile):
            color = colors[((x // tile) + (y // tile)) % 2]
            draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=color)
    return checker


def variance(values: list[int]) -> dict[str, float | int | None]:
    if not values:
        return {"min": None, "max": None, "variance": None}
    avg = sum(values) / len(values)
    var = sum((value - avg) ** 2 for value in values) / len(values)
    return {"min": min(values), "max": max(values), "variance": round(var, 4)}


def main() -> None:
    args = parse_args()
    if args.frames <= 0:
        raise SystemExit("--frames must be positive")
    if args.frame_size <= 0:
        raise SystemExit("--frame-size must be positive")

    clear_rect = parse_rect(args.clear_rect, args.frame_size)
    key = parse_hex_color(args.chroma_key)
    resample = resample_filter(args.resample)

    if args.source_frames_dir is not None:
        source_frames, source_names = load_frames_from_dir(args.source_frames_dir)
        source_root = args.source_frames_dir.resolve()
    else:
        source_frames, source_names = load_frames_from_sheet(args.source, args.frames)
        source_root = args.source.resolve()

    errors: list[str] = []
    warnings: list[str] = []
    if len(source_frames) != args.frames:
        errors.append(f"Expected {args.frames} frames, found {len(source_frames)}")

    source_sizes = [(frame.width, frame.height) for frame in source_frames]
    if args.layout_mode == "preserve-canvas" and len(set(source_sizes)) > 1:
        errors.append("Source canvas size changes across frames")

    args.frames_dir.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.preview.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)

    cells: list[Image.Image] = []
    frame_reports: list[dict[str, object]] = []
    edge_counts: list[int] = []

    for index, frame in enumerate(source_frames, start=1):
        working = frame.convert("RGBA")
        if args.background_mode == "chroma":
            working = chroma_removed(working, key, args.chroma_tolerance)
        working = remove_tiny_components(working, args.min_component_pixels)
        source_edge_count = edge_alpha_count(working)
        edge_counts.append(source_edge_count)

        if args.layout_mode == "preserve-canvas":
            cell, placement = preserve_canvas_cell(working, args.frame_size, resample)
        else:
            cell, placement = fit_foreground_cell(working, args.frame_size, resample)
        cell = apply_clear_rect(cell, clear_rect)

        cell_bbox = foreground_bbox(cell)
        if edge_alpha_count(cell) > 0:
            warnings.append(f"Frame {index} has visible pixels touching output cell edge")
        if source_edge_count > 0:
            warnings.append(f"Frame {index} has visible pixels touching source canvas edge")

        out_path = args.frames_dir / f"{args.frame_prefix}_{index:04d}.png"
        cell.save(out_path)
        cells.append(cell)
        frame_reports.append(
            {
                "index": index,
                "source": source_names[index - 1],
                "source_canvas_size": {"width": frame.width, "height": frame.height},
                "scaled_canvas_size": {
                    "width": placement.scaled_width,
                    "height": placement.scaled_height,
                },
                "scale": round(placement.scale, 6),
                "paste_location": {"x": placement.paste_x, "y": placement.paste_y},
                "final_bounding_box": bbox_record(cell_bbox),
                "source_edge_alpha_count": source_edge_count,
                "output": str(out_path),
            }
        )

    sheet = Image.new("RGBA", (args.frame_size * len(cells), args.frame_size), (0, 0, 0, 0))
    for index, cell in enumerate(cells):
        sheet.alpha_composite(cell, (index * args.frame_size, 0))
    sheet.save(args.output)

    preview = make_checker(sheet.size)
    preview.alpha_composite(sheet, (0, 0))
    preview.save(args.preview)

    diffs: list[dict[str, float | int]] = []
    duplicates: list[dict[str, float | int]] = []
    pops: list[dict[str, float | int]] = []
    for index in range(len(cells) - 1):
        ratio = round(alpha_diff_ratio(cells[index], cells[index + 1]), 6)
        item = {"from": index + 1, "to": index + 2, "silhouette_diff": ratio}
        diffs.append(item)
        if ratio < 0.002:
            duplicates.append(item)
        if ratio > 0.28:
            pops.append(item)
    if duplicates:
        warnings.append(f"{len(duplicates)} possible duplicate adjacent frame pair(s)")
    if pops:
        warnings.append(f"{len(pops)} possible motion pop(s)")

    bboxes = [foreground_bbox(cell) for cell in cells]
    widths = [bbox[2] - bbox[0] for bbox in bboxes if bbox is not None]
    heights = [bbox[3] - bbox[1] for bbox in bboxes if bbox is not None]
    expected_sheet_size = (args.frame_size * args.frames, args.frame_size)
    if sheet.size != expected_sheet_size:
        errors.append(f"Sheet size {sheet.size[0]}x{sheet.size[1]} != expected {expected_sheet_size[0]}x{expected_sheet_size[1]}")

    report = {
        "status": "fail" if errors else "pass",
        "errors": errors,
        "warnings": warnings,
        "frame_count": len(cells),
        "frame_size": args.frame_size,
        "sheet_size": {"width": sheet.width, "height": sheet.height},
        "source": str(source_root),
        "output_paths": {
            "sheet": str(args.output.resolve()),
            "preview": str(args.preview.resolve()),
            "frames_dir": str(args.frames_dir.resolve()),
            "report": str(args.report.resolve()),
        },
        "background_mode": args.background_mode,
        "layout_mode": args.layout_mode,
        "chroma_key": args.chroma_key,
        "chroma_tolerance": args.chroma_tolerance,
        "clear_rect": list(clear_rect) if clear_rect else None,
        "source_canvas_sizes": [
            {"width": width, "height": height} for width, height in source_sizes
        ],
        "frames": frame_reports,
        "source_edge_alpha_counts": edge_counts,
        "adjacent_frame_silhouette_differences": diffs,
        "possible_duplicate_frames": duplicates,
        "possible_motion_pops": pops,
        "possible_clipping_or_edge_contact": [
            item for item in frame_reports if item["source_edge_alpha_count"] != 0
        ],
        "frame_width_variance": variance(widths),
        "frame_height_variance": variance(heights),
    }
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(args.report)
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

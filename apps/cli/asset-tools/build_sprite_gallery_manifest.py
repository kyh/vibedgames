#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit("Pillow is required. Install with: python3 -m pip install Pillow") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build sprite_gallery_manifest.js.")
    parser.add_argument("--folder", required=True, type=Path)
    parser.add_argument("--output", default="sprite_gallery_manifest.js", type=Path)
    parser.add_argument("--limit", default=10, type=int)
    return parser.parse_args()


def should_skip(path: Path, root: Path) -> bool:
    rel = path.relative_to(root)
    parts = {part.lower() for part in rel.parts}
    return "frames" in parts or "previews" in parts or "contact_sheets" in parts


def split_name(path: Path, root: Path) -> tuple[str | None, str | None]:
    rel = path.relative_to(root)
    parts = rel.parts
    if len(parts) >= 4 and parts[-2].lower() == "sheets":
        return parts[-4], parts[-3]
    stem = path.stem
    match = re.match(r"(?P<character>[A-Za-z0-9_-]+)_(?P<animation>[A-Za-z0-9_-]+)_\d+f", stem)
    if match:
        return match.group("character"), match.group("animation")
    return None, None


def portable_path(path: Path, base: Path) -> str:
    try:
        return path.relative_to(base).as_posix()
    except ValueError:
        return path.as_posix()


def main() -> None:
    args = parse_args()
    root = args.folder.resolve()
    if not root.is_dir():
        raise SystemExit(f"Folder not found: {root}")
    entries = []
    for path in root.rglob("*.png"):
        if should_skip(path, root):
            continue
        stat = path.stat()
        with Image.open(path) as image:
            width, height = image.size
        character, animation = split_name(path, root)
        cwd = Path.cwd()
        rel_path = portable_path(path, cwd)
        rel_folder = portable_path(path.parent, cwd)
        entries.append(
            {
                "label": path.stem,
                "path": rel_path,
                "folder": rel_folder,
                "character": character,
                "animation": animation,
                "width": width,
                "height": height,
                "byteSize": stat.st_size,
                "modifiedTimestamp": stat.st_mtime,
            }
        )

    entries.sort(key=lambda item: item["modifiedTimestamp"], reverse=True)
    payload = (
        f"window.SPRITE_LATEST_LIMIT = {args.limit};\n"
        f"window.SPRITE_SHEETS = {json.dumps(entries, indent=2)};\n"
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(payload, encoding="utf-8")
    print(args.output)


if __name__ == "__main__":
    main()

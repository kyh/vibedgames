#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from _asset_common import image_paths


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Select ordered frames by 1-based index.")
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--indices", required=True)
    parser.add_argument("--frame-prefix", required=True)
    parser.add_argument("--notes", default=None)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def parse_indices(raw: str) -> list[int]:
    indices: list[int] = []
    for piece in raw.split(","):
        token = piece.strip()
        if not token:
            continue
        if "-" in token:
            left, right = token.split("-", 1)
            start = int(left)
            end = int(right)
            if start <= 0 or end <= 0:
                raise SystemExit("Frame indices are 1-based and must be positive")
            step = 1 if end >= start else -1
            indices.extend(range(start, end + step, step))
        else:
            value = int(token)
            if value <= 0:
                raise SystemExit("Frame indices are 1-based and must be positive")
            indices.append(value)
    if not indices:
        raise SystemExit("No frame indices selected")
    return indices


def parse_notes(raw: str | None, count: int) -> list[str]:
    if raw is None or raw.strip() == "":
        return ["human-selected" for _ in range(count)]
    notes = [note.strip() for note in raw.split(",")]
    if len(notes) != count:
        raise SystemExit(f"--notes count {len(notes)} does not match selected frame count {count}")
    return [note if note else "human-selected" for note in notes]


def main() -> None:
    args = parse_args()
    frames = image_paths(args.source_dir)
    if not frames:
        raise SystemExit(f"No source frames found in {args.source_dir}")

    selected = parse_indices(args.indices)
    for index in selected:
        if index > len(frames):
            raise SystemExit(f"Frame index {index} exceeds source frame count {len(frames)}")

    if args.output_dir.exists():
        existing = [path for path in args.output_dir.iterdir() if path.is_file()]
        if existing and not args.overwrite:
            raise SystemExit(f"Output directory is not empty: {args.output_dir}. Pass --overwrite.")
        if args.overwrite:
            for path in existing:
                path.unlink()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    notes = parse_notes(args.notes, len(selected))
    mappings = []
    for output_index, source_index in enumerate(selected, start=1):
        source = frames[source_index - 1]
        suffix = source.suffix.lower() if source.suffix else ".png"
        output = args.output_dir / f"{args.frame_prefix}_{output_index:04d}{suffix}"
        shutil.copyfile(source, output)
        mappings.append(
            {
                "output_index": output_index,
                "output_file": output.name,
                "source_index": source_index,
                "source_file": source.name,
                "note": notes[output_index - 1],
            }
        )

    report = {
        "source_dir": str(args.source_dir.resolve()),
        "output_dir": str(args.output_dir.resolve()),
        "total_source_frame_count": len(frames),
        "selected_frame_count": len(selected),
        "selected_source_indices": selected,
        "frames": mappings,
    }
    report_path = args.output_dir / "selection_report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(report_path)


if __name__ == "__main__":
    main()

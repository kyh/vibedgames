#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract full-resolution PNG frames from a video with ffmpeg."
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--fps", default=None)
    parser.add_argument("--crop", default=None)
    parser.add_argument("--pattern", default="frame_%04d.png")
    parser.add_argument("--start-number", type=int, default=1)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def require_tool(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise SystemExit(
            f"{name} not found on PATH. Install FFmpeg from ffmpeg.org or your package manager."
        )
    return path


def run_json(cmd: list[str]) -> dict[str, Any]:
    completed = subprocess.run(cmd, check=True, capture_output=True, text=True)
    raw = completed.stdout.strip()
    if not raw:
        return {}
    value = json.loads(raw)
    if isinstance(value, dict):
        return value
    return {}


def source_metadata(ffprobe: str, source: Path) -> dict[str, Any]:
    data = run_json(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(source),
        ]
    )
    streams = data.get("streams")
    stream = streams[0] if isinstance(streams, list) and streams else {}
    fmt = data.get("format") if isinstance(data.get("format"), dict) else {}
    return {
        "width": stream.get("width"),
        "height": stream.get("height"),
        "frame_rate": stream.get("avg_frame_rate") or stream.get("r_frame_rate"),
        "duration": stream.get("duration") or fmt.get("duration"),
        "frame_count": stream.get("nb_frames"),
    }


def matching_outputs(output_dir: Path, pattern: str) -> list[Path]:
    percent = pattern.find("%")
    if percent == -1:
        return [output_dir / pattern] if (output_dir / pattern).exists() else []
    prefix = pattern[:percent]
    suffix_start = pattern.find("d", percent)
    suffix = pattern[suffix_start + 1 :] if suffix_start != -1 else ""
    return sorted(output_dir.glob(f"{prefix}*{suffix}"))


def build_filter(crop: str | None, fps: str | None) -> str | None:
    filters: list[str] = []
    if crop:
        filters.append(f"crop={crop}")
    if fps:
        filters.append(f"fps={fps}")
    if not filters:
        return None
    return ",".join(filters)


def main() -> None:
    args = parse_args()
    ffmpeg = require_tool("ffmpeg")
    ffprobe = require_tool("ffprobe")

    source = args.input.resolve()
    if not source.is_file():
        raise SystemExit(f"Input video not found: {source}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    existing = matching_outputs(args.output_dir, args.pattern)
    if existing and not args.overwrite:
        raise SystemExit(
            f"Output already contains {len(existing)} matching frame(s). Pass --overwrite."
        )
    if existing and args.overwrite:
        for path in existing:
            path.unlink()

    output_pattern = args.output_dir / args.pattern
    ffmpeg_cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-start_number",
        str(args.start_number),
    ]
    filter_expr = build_filter(args.crop, args.fps)
    if filter_expr:
        ffmpeg_cmd.extend(["-vf", filter_expr])
    if args.fps is None:
        ffmpeg_cmd.extend(["-vsync", "0"])
    ffmpeg_cmd.append(str(output_pattern))

    subprocess.run(ffmpeg_cmd, check=True)

    frames = matching_outputs(args.output_dir, args.pattern)
    report = {
        "input": str(source),
        "output_dir": str(args.output_dir.resolve()),
        "output_pattern": args.pattern,
        "requested_fps": args.fps,
        "crop": args.crop,
        "mode": "constant-fps" if args.fps else "source-frame-passthrough",
        "source_metadata": source_metadata(ffprobe, source),
        "extracted_frame_count": len(frames),
        "ffmpeg_command": ffmpeg_cmd,
    }
    report_path = args.output_dir / "extraction_report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(report_path)


if __name__ == "__main__":
    main()

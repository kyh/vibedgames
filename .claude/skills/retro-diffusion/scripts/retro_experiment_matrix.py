#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Sequence

from retro_inference_run import parse_args as parse_run_args
from retro_inference_run import run_inference


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a Retro Diffusion experiment matrix from a JSON config.")
    parser.add_argument("--config", type=Path, required=True, help="Path to the experiment config JSON.")
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def _bool_flag_args(key: str, value: bool) -> list[str]:
    return [f"--{key.replace('_', '-')}", "true" if value else "false"]


def _run_args_from_config(config: dict[str, Any], run: dict[str, Any]) -> list[str]:
    args = [
        "--preset",
        run["preset"],
        "--prompt-file",
        config["prompt_file"],
        "--out-dir",
        run["out_dir"],
        "--filename-prefix",
        run["filename_prefix"],
        "--task-slug",
        run["task_slug"]
    ]

    if run.get("input_image"):
        args.extend(["--input-image", run["input_image"]])
    for value in run.get("reference_images", []):
        args.extend(["--reference-image", value])
    if run.get("input_palette"):
        args.extend(["--input-palette", run["input_palette"]])

    for key in ("width", "height", "num_images", "seed", "strength", "frames_duration"):
        value = run.get(key)
        if value is not None:
            args.extend([f"--{key.replace('_', '-')}", str(value)])

    for key in ("return_spritesheet", "remove_bg"):
        value = run.get(key)
        if isinstance(value, bool):
            args.extend(_bool_flag_args(key, value))

    if run.get("check_cost"):
        args.append("--check-cost")
    return args


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    config = json.loads(args.config.read_text(encoding="utf-8"))
    results: list[dict[str, Any]] = []
    for run in config.get("runs", []):
        run_args = parse_run_args(_run_args_from_config(config, run))
        results.append(run_inference(run_args))

    batch = {
        "task_slug": config.get("task_slug"),
        "prompt_file": config.get("prompt_file"),
        "results": results
    }
    output_path = Path(config["batch_output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(batch, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote Retro Diffusion batch to {output_path}")


if __name__ == "__main__":
    main()

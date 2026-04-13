#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Sequence

from _retro_common import (
    API_ROOT,
    base64_rgb_png,
    decode_base64_media,
    json_request,
    load_presets,
    media_extension,
    now_utc_iso,
    prompt_sha256,
    read_text,
    relative_path,
    require_rd_key,
    write_json,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one Retro Diffusion inference and write normalized artifacts.")
    parser.add_argument("--preset", required=True, help="Preset name from assets/model-presets.json.")
    parser.add_argument("--prompt", default=None, help="Prompt text.")
    parser.add_argument("--prompt-file", type=Path, default=None, help="Path to a text file containing the prompt.")
    parser.add_argument("--input-image", type=Path, default=None, help="Starting frame or img2img source.")
    parser.add_argument("--reference-image", type=Path, action="append", default=None, help="Extra reference image. Repeatable.")
    parser.add_argument("--input-palette", type=Path, default=None, help="Palette guidance image.")
    parser.add_argument("--width", type=int, default=None, help="Override width.")
    parser.add_argument("--height", type=int, default=None, help="Override height.")
    parser.add_argument("--num-images", type=int, default=None, help="Override num_images.")
    parser.add_argument("--seed", type=int, default=None, help="Override seed.")
    parser.add_argument("--strength", type=float, default=None, help="Override strength for input-image runs.")
    parser.add_argument("--frames-duration", type=int, default=None, help="Override frames_duration.")
    parser.add_argument("--return-spritesheet", choices=["true", "false"], default=None, help="Override return_spritesheet.")
    parser.add_argument("--remove-bg", choices=["true", "false"], default=None, help="Override remove_bg.")
    parser.add_argument("--check-cost", action="store_true", help="Estimate cost without generating.")
    parser.add_argument("--out-dir", type=Path, required=True, help="Directory where response and decoded outputs are written.")
    parser.add_argument("--filename-prefix", default="retro-diffusion", help="Base name for output files.")
    parser.add_argument("--task-slug", default="retro-diffusion-task", help="Stable task slug for tracking.")
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def _prompt_text(args: argparse.Namespace) -> str:
    if bool(args.prompt) == bool(args.prompt_file):
        raise SystemExit("Use exactly one of --prompt or --prompt-file")
    return read_text(args.prompt_file) if args.prompt_file else str(args.prompt).strip()


def _cli_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    return value == "true"


def _build_payload(args: argparse.Namespace, preset: dict[str, Any], prompt_text: str) -> tuple[dict[str, Any], dict[str, Any]]:
    payload = dict(preset.get("defaults", {}))
    payload["prompt_style"] = preset["prompt_style"]
    payload["prompt"] = prompt_text

    if args.width is not None:
        payload["width"] = args.width
    if args.height is not None:
        payload["height"] = args.height
    if args.num_images is not None:
        payload["num_images"] = args.num_images
    if args.seed is not None:
        payload["seed"] = args.seed
    if args.strength is not None:
        payload["strength"] = args.strength
    if args.frames_duration is not None:
        payload["frames_duration"] = args.frames_duration

    return_spritesheet = _cli_bool(args.return_spritesheet)
    if return_spritesheet is not None:
        payload["return_spritesheet"] = return_spritesheet

    remove_bg = _cli_bool(args.remove_bg)
    if remove_bg is not None:
        payload["remove_bg"] = remove_bg

    if args.check_cost:
        payload["check_cost"] = True

    input_manifest = {
        "input_image": relative_path(args.input_image) if args.input_image else None,
        "reference_images": [relative_path(path) for path in (args.reference_image or [])],
        "input_palette": relative_path(args.input_palette) if args.input_palette else None,
    }

    if args.input_image:
        payload["input_image"] = base64_rgb_png(args.input_image)
    if args.reference_image:
        payload["reference_images"] = [base64_rgb_png(path) for path in args.reference_image]
    if args.input_palette:
        payload["input_palette"] = base64_rgb_png(args.input_palette)

    return payload, input_manifest


def _write_media_outputs(response: dict[str, Any], out_dir: Path, filename_prefix: str) -> list[str]:
    output_files: list[str] = []
    for index, encoded in enumerate(response.get("base64_images") or [], start=1):
        raw = decode_base64_media(encoded)
        path = out_dir / f"{filename_prefix}-output-{index:02d}{media_extension(raw)}"
        path.write_bytes(raw)
        output_files.append(relative_path(path))
    return output_files


def run_inference(args: argparse.Namespace) -> dict[str, Any]:
    presets = load_presets()
    if args.preset not in presets:
        known = ", ".join(sorted(presets))
        raise SystemExit(f"Unknown preset: {args.preset}. Known presets: {known}")

    preset = presets[args.preset]
    prompt_text = _prompt_text(args)
    started_at = now_utc_iso()
    payload, input_manifest = _build_payload(args, preset, prompt_text)

    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    response_path = out_dir / f"{args.filename_prefix}-response.json"
    run_path = out_dir / f"{args.filename_prefix}-run.json"

    api_key = require_rd_key()
    response = json_request(f"{API_ROOT}/inferences", payload, api_key)
    write_json(response_path, response)
    output_files = [] if args.check_cost else _write_media_outputs(response, out_dir, args.filename_prefix)

    sanitized_payload = {
        key: value
        for key, value in payload.items()
        if key not in {"input_image", "reference_images", "input_palette"}
    }
    manifest = {
        "timestamp": started_at,
        "task_slug": args.task_slug,
        "provider": "retro-diffusion",
        "preset": args.preset,
        "family": preset.get("family"),
        "prompt_style": preset.get("prompt_style"),
        "model": response.get("model"),
        "prompt_text": prompt_text,
        "prompt_hash": prompt_sha256(prompt_text),
        "input_source": input_manifest,
        "resolved_arguments": sanitized_payload,
        "status": "cost_only" if args.check_cost else "completed",
        "balance_cost": response.get("balance_cost"),
        "remaining_balance": response.get("remaining_balance"),
        "created_at_epoch": response.get("created_at"),
        "output_files": output_files,
        "output_urls": response.get("output_urls") or [],
        "response_json": relative_path(response_path)
    }
    write_json(run_path, manifest)
    return manifest


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    manifest = run_inference(args)
    print(f"Wrote {manifest['status']} Retro Diffusion run to {args.out_dir}")


if __name__ == "__main__":
    main()

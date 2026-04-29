#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Run one Retro Diffusion inference through the vibedgames CLI and write
normalized tracking artifacts.

Routes through `vg image generate --provider retro-diffusion`; the platform
holds the Retro Diffusion API key, so users only need to be authenticated
with `vg login`.

The matrix runner (`retro_experiment_matrix.py`) imports ``parse_args`` and
``run_inference`` from this module, so those names are preserved.
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Sequence

from _retro_common import (
    base64_rgb_png,
    load_presets,
    now_utc_iso,
    prompt_sha256,
    read_text,
    relative_path,
    write_json,
)
from _vg import run_vg_image


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one Retro Diffusion inference via vg and write normalized artifacts.")
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


def _build_params(args: argparse.Namespace, preset: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Build the params dict the vg CLI forwards to the Retro Diffusion provider.

    Retro Diffusion accepts input_image / reference_images / input_palette as
    inline base64 strings on the same JSON request, so they live in `params`
    rather than vg's `--image` flag (which is for providers that take real
    multipart uploads).
    """
    params = dict(preset.get("defaults", {}))

    if args.width is not None:
        params["width"] = args.width
    if args.height is not None:
        params["height"] = args.height
    if args.num_images is not None:
        params["num_images"] = args.num_images
    if args.seed is not None:
        params["seed"] = args.seed
    if args.strength is not None:
        params["strength"] = args.strength
    if args.frames_duration is not None:
        params["frames_duration"] = args.frames_duration

    return_spritesheet = _cli_bool(args.return_spritesheet)
    if return_spritesheet is not None:
        params["return_spritesheet"] = return_spritesheet

    remove_bg = _cli_bool(args.remove_bg)
    if remove_bg is not None:
        params["remove_bg"] = remove_bg

    if args.check_cost:
        params["check_cost"] = True

    input_manifest = {
        "input_image": relative_path(args.input_image) if args.input_image else None,
        "reference_images": [relative_path(path) for path in (args.reference_image or [])],
        "input_palette": relative_path(args.input_palette) if args.input_palette else None,
    }

    if args.input_image:
        params["input_image"] = base64_rgb_png(args.input_image)
    if args.reference_image:
        params["reference_images"] = [base64_rgb_png(path) for path in args.reference_image]
    if args.input_palette:
        params["input_palette"] = base64_rgb_png(args.input_palette)

    return params, input_manifest


def run_inference(args: argparse.Namespace) -> dict[str, Any]:
    presets = load_presets()
    if args.preset not in presets:
        known = ", ".join(sorted(presets))
        raise SystemExit(f"Unknown preset: {args.preset}. Known presets: {known}")

    preset = presets[args.preset]
    prompt_text = _prompt_text(args)
    started_at = now_utc_iso()
    params, input_manifest = _build_params(args, preset)

    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    response_path = out_dir / f"{args.filename_prefix}-response.json"
    run_path = out_dir / f"{args.filename_prefix}-run.json"

    response = run_vg_image(
        task="generate",
        provider="retro-diffusion",
        model=str(preset["prompt_style"]),
        prompt=prompt_text,
        out_dir=out_dir,
        filename_prefix=args.filename_prefix,
        params=params,
    )
    write_json(response_path, response)

    metadata = response.get("metadata") or {}
    sanitized_payload = {
        key: value
        for key, value in params.items()
        if key not in {"input_image", "reference_images", "input_palette"}
    }

    manifest = {
        "timestamp": started_at,
        "task_slug": args.task_slug,
        "provider": "retro-diffusion",
        "preset": args.preset,
        "family": preset.get("family"),
        "prompt_style": preset.get("prompt_style"),
        "model": metadata.get("model"),
        "prompt_text": prompt_text,
        "prompt_hash": prompt_sha256(prompt_text),
        "input_source": input_manifest,
        "resolved_arguments": sanitized_payload,
        "status": "cost_only" if args.check_cost else "completed",
        "balance_cost": metadata.get("balance_cost"),
        "remaining_balance": metadata.get("remaining_balance"),
        "created_at_epoch": metadata.get("created_at"),
        "output_files": list(response.get("outputs") or []),
        "output_urls": list(metadata.get("output_urls") or []),
        "vg_run_id": response.get("runId"),
        "response_json": relative_path(response_path),
    }
    write_json(run_path, manifest)
    return manifest


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    manifest = run_inference(args)
    print(f"Wrote {manifest['status']} Retro Diffusion run to {args.out_dir}")


if __name__ == "__main__":
    main()

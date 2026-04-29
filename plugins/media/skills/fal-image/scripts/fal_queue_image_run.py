#!/usr/bin/env python3
"""
Run one fal.ai image queue job through the vibedgames CLI and write
normalized tracking artifacts.

Routes through `vg image generate/edit --provider fal`; the platform holds
the FAL API key, so users only need to be authenticated with `vg login`.

The matrix runner (`fal_image_experiment_matrix.py`) imports
``parse_args`` and ``run_image_job`` from this module, so those names are
preserved.
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Sequence

from _fal_common import (
    coerce_json_object,
    load_presets,
    now_utc_iso,
    prompt_sha256,
    read_text,
    repo_relative,
    write_json,
)
from _vg import run_vg_image


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a fal.ai image job via vg and write normalized tracking artifacts.")
    parser.add_argument("--model-alias", default=None, help="Friendly alias from assets/model-presets.json.")
    parser.add_argument("--endpoint-id", default=None, help="Raw fal endpoint id. Overrides preset endpoint.")
    parser.add_argument("--prompt", default=None, help="Prompt text.")
    parser.add_argument("--prompt-file", type=Path, default=None, help="Path to a text file containing the prompt.")
    parser.add_argument("--image-file", type=Path, action="append", default=None, help="Local input image file. Repeat for edits with multiple references.")
    parser.add_argument("--image-url", action="append", default=None, help="Hosted input image URL. Repeatable.")
    parser.add_argument("--out-dir", type=Path, required=True, help="Directory where JSON, manifest, and images are written.")
    parser.add_argument("--filename-prefix", default="fal-image", help="Base name prefix for output files.")
    parser.add_argument("--task-slug", default="fal-image-task", help="Stable task slug for tracking.")
    parser.add_argument("--num-images", type=int, default=None, help="Override num_images.")
    parser.add_argument("--aspect-ratio", default=None, help="Override aspect_ratio.")
    parser.add_argument("--resolution", default=None, help="Override resolution.")
    parser.add_argument("--image-size", default=None, help="Override image_size.")
    parser.add_argument("--background", default=None, help="Override background.")
    parser.add_argument("--output-format", default=None, help="Override output_format.")
    parser.add_argument("--quality", default=None, help="Override quality.")
    parser.add_argument("--seed", type=int, default=None, help="Override seed.")
    parser.add_argument("--sync-mode", choices=["true", "false"], default=None, help="Override sync_mode.")
    parser.add_argument("--extra-json", default=None, help="Extra JSON object merged into the model arguments.")
    parser.add_argument("--dry-run", action="store_true", help="Write a resolved manifest without submitting the job.")
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def _bool_from_cli(value: str | None) -> bool | None:
    if value is None:
        return None
    return value == "true"


def _prompt_text(args: argparse.Namespace) -> str:
    if bool(args.prompt) == bool(args.prompt_file):
        raise SystemExit("Use exactly one of --prompt or --prompt-file")
    if args.prompt_file is not None:
        return read_text(args.prompt_file)
    return str(args.prompt).strip()


def _resolve_preset(args: argparse.Namespace) -> dict[str, Any]:
    presets = load_presets()
    if args.model_alias is None and args.endpoint_id is None:
        raise SystemExit("Use --model-alias or --endpoint-id")
    if args.model_alias is not None:
        preset = presets.get(args.model_alias)
        if preset is None:
            known = ", ".join(sorted(presets))
            raise SystemExit(f"Unknown model alias: {args.model_alias}. Known aliases: {known}")
        return preset
    return {
        "provider": "fal",
        "family": "custom",
        "endpoint_id": args.endpoint_id,
        "task_type": "text-to-image",
        "defaults": {},
    }


def _resolve_arguments(args: argparse.Namespace, preset: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    resolved: dict[str, Any] = dict(preset.get("defaults", {}))

    overrides: dict[str, Any] = {}
    if args.num_images is not None:
        overrides["num_images"] = args.num_images
    if args.aspect_ratio is not None:
        overrides["aspect_ratio"] = args.aspect_ratio
    if args.resolution is not None:
        overrides["resolution"] = args.resolution
    if args.image_size is not None:
        overrides["image_size"] = args.image_size
    if args.background is not None:
        overrides["background"] = args.background
    if args.output_format is not None:
        overrides["output_format"] = args.output_format
    if args.quality is not None:
        overrides["quality"] = args.quality
    if args.seed is not None:
        overrides["seed"] = args.seed
    if args.sync_mode is not None:
        overrides["sync_mode"] = _bool_from_cli(args.sync_mode)

    resolved.update(overrides)
    resolved.update(coerce_json_object(args.extra_json))

    image_field = preset.get("input_image_field")
    if image_field:
        # The vg fal provider needs to know which fal arg to pack image data
        # into (image_url, image_urls, etc.). Forward via params.
        resolved["input_image_field"] = image_field

    return resolved, overrides


def run_image_job(args: argparse.Namespace) -> dict[str, Any]:
    preset = _resolve_preset(args)
    prompt_text = _prompt_text(args)
    resolved_arguments, overrides = _resolve_arguments(args, preset)

    started_at = now_utc_iso()
    task_type = str(preset.get("task_type", "text-to-image"))
    task = "edit" if task_type == "image-edit" else "generate"
    image_files = list(args.image_file or [])
    image_urls = list(args.image_url or [])
    if image_urls:
        # Hosted URLs go straight to fal via the preset's image field; the
        # vg fal provider forwards `params` untouched. Local files still go
        # through vg --image so the platform can encode and proxy them.
        field = preset.get("input_image_field") or "image_urls"
        existing = resolved_arguments.get(field)
        if isinstance(existing, list):
            resolved_arguments[field] = list(existing) + image_urls
        else:
            resolved_arguments[field] = image_urls
    if task == "edit" and not image_files and not image_urls:
        raise SystemExit("Edit presets require at least one --image-file or --image-url")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out_dir / f"{args.filename_prefix}-run.json"

    manifest: dict[str, Any] = {
        "timestamp": started_at,
        "task_slug": args.task_slug,
        "provider": preset.get("provider", "fal"),
        "model_alias": args.model_alias,
        "family": preset.get("family"),
        "endpoint_id": preset["endpoint_id"],
        "task_type": preset.get("task_type"),
        "status": "dry_run" if args.dry_run else "pending",
        "prompt_text": prompt_text,
        "prompt_hash": prompt_sha256(prompt_text),
        "input_source": {
            "image_files": [repo_relative(path) for path in image_files],
            "image_urls": image_urls,
            "input_image_field": preset.get("input_image_field"),
        },
        "resolved_arguments": resolved_arguments,
        "preset_defaults": preset.get("defaults", {}),
        "explicit_overrides": overrides,
        "request_id": None,
        "output_files": [],
        "output_urls": [],
        # Server-side cost tracking is not exposed to skill users; left null
        # so the matrix ledger continues to read these fields safely.
        "estimated_cost": None,
        "estimated_cost_method": None,
        "cost_currency": None,
        "billable_units_header": None,
        "raw_files": {},
        "notes": [],
    }
    write_json(manifest_path, manifest)

    if args.dry_run:
        return manifest

    response = run_vg_image(
        task=task,
        provider="fal",
        model=str(preset["endpoint_id"]),
        prompt=prompt_text,
        out_dir=args.out_dir,
        filename_prefix=args.filename_prefix,
        params=resolved_arguments,
        images=image_files,
    )

    metadata = response.get("metadata") or {}
    response_path = args.out_dir / f"{args.filename_prefix}-vg-response.json"
    write_json(response_path, response)

    manifest.update(
        {
            "status": "completed",
            "completed_at": now_utc_iso(),
            "request_id": metadata.get("request_id"),
            "billable_units_header": metadata.get("billable_units"),
            "output_files": [repo_relative(Path(p)) for p in response.get("outputs") or []],
            "output_urls": [],
            "vg_run_id": response.get("runId"),
            "raw_files": {
                "vg_response_json": repo_relative(response_path),
            },
        }
    )

    fal_result = metadata.get("result")
    if isinstance(fal_result, dict):
        result_error = fal_result.get("error") or fal_result.get("detail")
        if result_error:
            manifest["notes"].append(f"fal result included error/detail: {result_error}")

    write_json(manifest_path, manifest)
    return manifest


def main() -> None:
    args = parse_args()
    run_image_job(args)


if __name__ == "__main__":
    main()

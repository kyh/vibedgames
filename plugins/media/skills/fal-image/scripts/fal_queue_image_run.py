#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path
from typing import Any, Sequence

from _fal_common import (
    build_unit_price_estimate_payload,
    collect_media_outputs,
    coerce_json_object,
    data_uri_for_file,
    default_platform_headers,
    download_file,
    load_presets,
    now_utc_iso,
    platform_get,
    platform_post,
    prompt_sha256,
    queue_get_by_url,
    queue_result,
    queue_status,
    queue_submit,
    read_text,
    repo_relative,
    require_fal_key,
    write_json,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a fal.ai image queue job and write normalized tracking artifacts.")
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
    parser.add_argument("--headers-json", default=None, help="Extra JSON object merged into fal request headers.")
    parser.add_argument("--poll-interval", type=float, default=10.0, help="Seconds between status polls.")
    parser.add_argument("--timeout", type=int, default=900, help="Maximum seconds to wait for completion.")
    parser.add_argument("--no-wait", action="store_true", help="Submit the job and stop before polling.")
    parser.add_argument("--no-download", action="store_true", help="Poll to completion but skip image download.")
    parser.add_argument("--no-store-io", action="store_true", help="Disable X-Fal-Store-IO.")
    parser.add_argument("--allow-fallback", action="store_true", help="Do not set x-app-fal-disable-fallback=true.")
    parser.add_argument("--dry-run", action="store_true", help="Write a resolved manifest without submitting the job.")
    parser.add_argument("--estimate-unit-quantity", type=float, default=None, help="Billing units passed to the pricing estimate endpoint. Defaults to num_images or 1.")
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
        "download_keys": ["images[0].url"],
        "defaults": {},
    }


def _resolved_image_inputs(args: argparse.Namespace) -> list[str]:
    resolved: list[str] = []
    for path in args.image_file or []:
        resolved.append(data_uri_for_file(path))
    for url in args.image_url or []:
        resolved.append(str(url))
    return resolved


def _input_source_manifest(args: argparse.Namespace, preset: dict[str, Any]) -> dict[str, Any]:
    return {
        "image_files": [repo_relative(path) for path in (args.image_file or [])],
        "image_urls": list(args.image_url or []),
        "input_image_field": preset.get("input_image_field"),
    }


def _resolve_arguments(args: argparse.Namespace, preset: dict[str, Any], prompt_text: str) -> tuple[dict[str, Any], dict[str, Any]]:
    task_type = str(preset.get("task_type", "text-to-image"))
    resolved = dict(preset.get("defaults", {}))
    resolved["prompt"] = prompt_text

    image_inputs = _resolved_image_inputs(args)
    if task_type == "image-edit":
        if not image_inputs:
            raise SystemExit("Edit presets require at least one --image-file or --image-url")
        image_field = str(preset.get("input_image_field", "image_urls"))
        resolved[image_field] = image_inputs
    elif image_inputs and preset.get("input_image_field"):
        resolved[str(preset["input_image_field"])] = image_inputs

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
    return resolved, overrides


def _estimate_cost(api_key: str, endpoint_id: str, unit_quantity: float) -> dict[str, Any] | None:
    payload = build_unit_price_estimate_payload(endpoint_id, unit_quantity)
    try:
        estimate = platform_post("/models/pricing/estimate", api_key, payload).payload
        if isinstance(estimate, dict):
            return estimate
    except SystemExit:
        pass

    pricing = platform_get("/models/pricing", api_key, {"endpoint_id": endpoint_id}).payload
    prices = pricing.get("prices") if isinstance(pricing, dict) else None
    if isinstance(prices, list) and prices:
        first = prices[0]
        if isinstance(first, dict):
            unit_price = first.get("unit_price")
            currency = first.get("currency")
            unit = first.get("unit")
            if isinstance(unit_price, (int, float)):
                return {
                    "estimate_type": "unit_price_fallback",
                    "total_cost": float(unit_price) * unit_quantity,
                    "currency": currency,
                    "unit": unit,
                    "unit_quantity": unit_quantity,
                }
    return None


def run_image_job(args: argparse.Namespace) -> dict[str, Any]:
    preset = _resolve_preset(args)
    prompt_text = _prompt_text(args)
    resolved_arguments, overrides = _resolve_arguments(args, preset, prompt_text)

    request_headers = default_platform_headers(
        store_io=not args.no_store_io,
        disable_fallback=not args.allow_fallback,
    )
    request_headers.update(coerce_json_object(args.headers_json))

    started_at = now_utc_iso()
    estimate_unit_quantity = args.estimate_unit_quantity
    if estimate_unit_quantity is None:
        value = resolved_arguments.get("num_images", 1)
        estimate_unit_quantity = float(value) if isinstance(value, (int, float, str)) else 1.0

    api_key = None if args.dry_run else require_fal_key()
    estimated_cost = (
        _estimate_cost(api_key, str(preset["endpoint_id"]), estimate_unit_quantity)  # type: ignore[arg-type]
        if api_key is not None
        else None
    )

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
        "input_source": _input_source_manifest(args, preset),
        "resolved_arguments": resolved_arguments,
        "preset_defaults": preset.get("defaults", {}),
        "explicit_overrides": overrides,
        "headers": request_headers,
        "request_id": None,
        "output_files": [],
        "output_urls": [],
        "estimated_cost": estimated_cost,
        "estimated_cost_method": estimated_cost.get("estimate_type") if isinstance(estimated_cost, dict) else None,
        "reconciled_cost": None,
        "cost_currency": estimated_cost.get("currency") if isinstance(estimated_cost, dict) else None,
        "raw_files": {},
        "notes": [],
    }

    args.out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out_dir / f"{args.filename_prefix}-run.json"
    write_json(manifest_path, manifest)

    if args.dry_run:
        return manifest

    create_response = None
    create_payload: dict[str, Any]
    request_id: str
    response_url: str | None = None
    status_url: str | None = None

    try:
        import fal_client  # type: ignore

        os.environ.setdefault("FAL_KEY", api_key)
        client = fal_client.SyncClient(key=api_key)
        live_arguments = dict(resolved_arguments)
        image_field = preset.get("input_image_field")
        if image_field and args.image_file:
            encoded_inputs = [fal_client.encode_file(str(path)) for path in args.image_file]
            encoded_inputs.extend(args.image_url or [])
            live_arguments[str(image_field)] = encoded_inputs
        handle = client.submit(str(preset["endpoint_id"]), live_arguments, headers=request_headers)
        request_id = handle.request_id
        response_url = handle.response_url
        status_url = handle.status_url
        create_payload = {
            "request_id": handle.request_id,
            "response_url": handle.response_url,
            "status_url": handle.status_url,
            "cancel_url": handle.cancel_url,
        }
    except ImportError:
        create_response = queue_submit(str(preset["endpoint_id"]), api_key, resolved_arguments, headers=request_headers)
        create_payload = create_response.payload
        request_id = create_payload.get("request_id")
        if not isinstance(request_id, str) or not request_id:
            raise SystemExit("fal queue response did not include request_id")

    create_json_path = args.out_dir / f"{args.filename_prefix}-create.json"
    create_meta_path = args.out_dir / f"{args.filename_prefix}-create-meta.json"
    write_json(create_json_path, create_payload)
    if create_response is not None:
        write_json(create_meta_path, {"status_code": create_response.status_code, "headers": create_response.headers})
    else:
        write_json(create_meta_path, {"status_code": 200, "headers": {}, "client": "fal_client"})

    manifest["request_id"] = request_id
    manifest["status"] = "submitted"
    manifest["raw_files"]["create_json"] = repo_relative(create_json_path)
    manifest["raw_files"]["create_meta_json"] = repo_relative(create_meta_path)
    write_json(manifest_path, manifest)

    if args.no_wait:
        return manifest

    deadline = time.time() + args.timeout
    latest_status_headers: dict[str, Any] | None = None

    while True:
        if status_url is not None:
            status_response = queue_get_by_url(status_url, api_key, headers=request_headers, query={"logs": 1})
        else:
            status_response = queue_status(str(preset["endpoint_id"]), request_id, api_key, headers=request_headers, logs=True)
        latest_status_headers = status_response.headers
        status = str(status_response.payload.get("status", "")).upper()
        manifest["status"] = status.lower() if status else "unknown"
        write_json(args.out_dir / f"{args.filename_prefix}-status.json", status_response.payload)
        write_json(args.out_dir / f"{args.filename_prefix}-status-meta.json", {"status_code": status_response.status_code, "headers": status_response.headers})
        write_json(manifest_path, manifest)

        if status == "COMPLETED":
            break
        if time.time() >= deadline:
            raise SystemExit(f"Timed out waiting for request {request_id}")
        time.sleep(args.poll_interval)

    if response_url is not None:
        result_response = queue_get_by_url(response_url, api_key, headers=request_headers)
    else:
        result_response = queue_result(str(preset["endpoint_id"]), request_id, api_key, headers=request_headers)
    result_json_path = args.out_dir / f"{args.filename_prefix}-final.json"
    result_meta_path = args.out_dir / f"{args.filename_prefix}-final-meta.json"
    write_json(result_json_path, result_response.payload)
    write_json(result_meta_path, {"status_code": result_response.status_code, "headers": result_response.headers})

    media_outputs = collect_media_outputs(result_response.payload)
    downloaded_files: list[str] = []
    output_urls = [item["url"] for item in media_outputs]

    if not args.no_download:
        for index, item in enumerate(media_outputs, start=1):
            extension = Path(str(item.get("file_name", ""))).suffix or ".png"
            output_path = args.out_dir / f"{args.filename_prefix}-output-{index:02d}{extension}"
            download_file(str(item["url"]), output_path)
            downloaded_files.append(repo_relative(output_path))

    billable_units = None
    if latest_status_headers and "x-fal-billable-units" in latest_status_headers:
        billable_units = latest_status_headers["x-fal-billable-units"]
    if result_response.headers.get("x-fal-billable-units"):
        billable_units = result_response.headers["x-fal-billable-units"]

    manifest.update(
        {
            "status": "completed",
            "completed_at": now_utc_iso(),
            "output_files": downloaded_files,
            "output_urls": output_urls,
            "billable_units_header": billable_units,
            "request_headers_seen": {
                "status": latest_status_headers,
                "result": result_response.headers,
            },
            "raw_files": {
                **manifest["raw_files"],
                "status_json": repo_relative(args.out_dir / f"{args.filename_prefix}-status.json"),
                "status_meta_json": repo_relative(args.out_dir / f"{args.filename_prefix}-status-meta.json"),
                "final_json": repo_relative(result_json_path),
                "final_meta_json": repo_relative(result_meta_path),
            },
        }
    )

    if isinstance(result_response.payload, dict):
        result_error = result_response.payload.get("error") or result_response.payload.get("detail")
        if result_error:
            manifest["notes"].append(f"Result payload included error/detail: {result_error}")

    write_json(manifest_path, manifest)
    return manifest


def main() -> None:
    args = parse_args()
    run_image_job(args)


if __name__ == "__main__":
    main()


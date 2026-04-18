#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from _fal_common import (
    append_jsonl,
    load_jsonl,
    now_utc_iso,
    repo_relative,
    timestamp_slug,
    write_csv,
    write_json,
)
from fal_queue_image_run import parse_args as parse_runner_args
from fal_queue_image_run import run_image_job


LEDGER_FIELDS = [
    "timestamp",
    "task_slug",
    "model_alias",
    "endpoint_id",
    "request_id",
    "status",
    "estimated_cost",
    "estimated_cost_method",
    "cost_currency",
    "billable_units_header",
    "output_files",
    "output_urls",
    "run_manifest",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the same fal image task across a configured model matrix.")
    parser.add_argument("--config", type=Path, required=True, help="Path to the experiment config JSON file.")
    parser.add_argument("--timestamp", default=None, help="Optional fixed batch timestamp.")
    parser.add_argument("--dry-run", action="store_true", help="Resolve runs without submitting them.")
    return parser.parse_args()


def _load_config(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit("Config must be a JSON object")
    return payload


def _prompt_spec(config: dict[str, Any]) -> tuple[str, str]:
    if bool(config.get("prompt")) == bool(config.get("prompt_file")):
        raise SystemExit("Config must include exactly one of prompt or prompt_file")
    if config.get("prompt"):
        return "prompt", str(config["prompt"])
    return "prompt_file", str(config["prompt_file"])


def _extend_input_flags(runner_args: list[str], config: dict[str, Any]) -> None:
    for item in config.get("input_images", []) or []:
        value = str(item)
        if value.startswith("http://") or value.startswith("https://") or value.startswith("data:"):
            runner_args.extend(["--image-url", value])
        else:
            runner_args.extend(["--image-file", value])


def main() -> None:
    args = parse_args()
    config = _load_config(args.config)
    batch_timestamp = args.timestamp or timestamp_slug()

    batch_dir = Path("experiments/fal-image") / f"{batch_timestamp}-{config['task_slug']}"
    batch_dir.mkdir(parents=True, exist_ok=True)

    tracking = config.get("tracking", {})
    ledger_jsonl = Path(tracking.get("ledger_jsonl", "experiments/fal-image/ledger.jsonl"))
    ledger_csv = Path(tracking.get("ledger_csv", "experiments/fal-image/ledger.csv"))
    prompt_key, prompt_value = _prompt_spec(config)

    batch_payload = {
        "timestamp": batch_timestamp,
        "task_slug": config["task_slug"],
        "created_at": now_utc_iso(),
        "prompt": config.get("prompt"),
        "prompt_file": config.get("prompt_file"),
        "input_images": config.get("input_images", []),
        "models": config["models"],
        "output_root": config["output_root"],
        "config_path": repo_relative(args.config),
    }
    write_json(batch_dir / "batch.json", batch_payload)

    results: list[dict[str, Any]] = []
    for model_alias in config["models"]:
        runner_args = [
            "--model-alias",
            str(model_alias),
            "--task-slug",
            str(config["task_slug"]),
            "--out-dir",
            str(Path(config["output_root"]) / f"{batch_timestamp}-{config['task_slug']}-fal-{model_alias}"),
            "--filename-prefix",
            f"{batch_timestamp}-{config['task_slug']}-{model_alias}",
            f"--{prompt_key.replace('_', '-')}",
            prompt_value,
        ]

        _extend_input_flags(runner_args, config)

        model_overrides = (config.get("model_overrides") or {}).get(model_alias, {})
        for key, value in model_overrides.items():
            flag = f"--{key.replace('_', '-')}"
            runner_args.extend([flag, str(value).lower() if isinstance(value, bool) else str(value)])
        if args.dry_run:
            runner_args.append("--dry-run")

        runner_namespace = parse_runner_args(runner_args)
        manifest = run_image_job(runner_namespace)
        manifest_path = Path(runner_namespace.out_dir) / f"{runner_namespace.filename_prefix}-run.json"
        ledger_row = {
            "timestamp": manifest.get("timestamp"),
            "task_slug": manifest.get("task_slug"),
            "model_alias": manifest.get("model_alias"),
            "endpoint_id": manifest.get("endpoint_id"),
            "request_id": manifest.get("request_id"),
            "status": manifest.get("status"),
            "estimated_cost": (manifest.get("estimated_cost") or {}).get("total_cost") if isinstance(manifest.get("estimated_cost"), dict) else None,
            "estimated_cost_method": manifest.get("estimated_cost_method"),
            "cost_currency": manifest.get("cost_currency"),
            "billable_units_header": manifest.get("billable_units_header"),
            "output_files": "|".join(manifest.get("output_files", [])),
            "output_urls": "|".join(manifest.get("output_urls", [])),
            "run_manifest": repo_relative(manifest_path),
        }
        append_jsonl(ledger_jsonl, ledger_row)
        results.append(ledger_row)

    existing_rows = load_jsonl(ledger_jsonl)
    write_csv(ledger_csv, existing_rows, LEDGER_FIELDS)
    write_json(batch_dir / "results.json", {"rows": results})


if __name__ == "__main__":
    main()


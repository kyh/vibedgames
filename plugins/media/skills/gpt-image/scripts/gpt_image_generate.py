#!/usr/bin/env python3
"""
Generate images with `gpt-image-1.5` via the vibedgames CLI.

Routes through `vg image generate --provider openai`; the platform holds the
OpenAI API key, so the user only needs to be authenticated with `vg login`.

Usage:
  python3 gpt_image_generate.py \
    --prompt "Glass potion bottle icon, transparent background" \
    --out-dir tmp/potion
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from _vg import run_vg_image


VALID_SIZES = {"1024x1024", "1024x1536", "1536x1024", "auto"}
VALID_QUALITIES = {"low", "medium", "high", "auto"}
VALID_FORMATS = {"png", "webp", "jpeg"}
VALID_BACKGROUNDS = {"transparent", "opaque", "auto"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate images with gpt-image-1.5 via vg.")
    parser.add_argument("--prompt", required=True, help="Text prompt for image generation.")
    parser.add_argument("--model", default="gpt-image-1.5", help="Model name. Defaults to gpt-image-1.5.")
    parser.add_argument("--out-dir", type=Path, required=True, help="Directory where generated images will be written.")
    parser.add_argument("--filename-prefix", default="image", help="Prefix for output filenames.")
    parser.add_argument("--n", type=int, default=1, help="Number of images to request.")
    parser.add_argument("--size", default="1024x1024", choices=sorted(VALID_SIZES))
    parser.add_argument("--quality", default="medium", choices=sorted(VALID_QUALITIES))
    parser.add_argument("--output-format", default="png", choices=sorted(VALID_FORMATS))
    parser.add_argument("--background", default="opaque", choices=sorted(VALID_BACKGROUNDS))
    parser.add_argument("--user", default=None, help="Optional user identifier for tracing.")
    parser.add_argument("--print-json", action="store_true", help="Print the raw vg JSON response.")
    return parser.parse_args()


def ensure_supported_settings(args: argparse.Namespace) -> None:
    if args.background == "transparent" and args.output_format not in {"png", "webp"}:
        raise SystemExit("transparent background requires --output-format png or webp")
    if args.n < 1:
        raise SystemExit("--n must be >= 1")


def build_params(args: argparse.Namespace) -> dict:
    params: dict = {
        "n": args.n,
        "size": args.size,
        "quality": args.quality,
        "output_format": args.output_format,
        "background": args.background,
    }
    if args.user:
        params["user"] = args.user
    return params


def main() -> None:
    args = parse_args()
    ensure_supported_settings(args)
    response = run_vg_image(
        task="generate",
        provider="openai",
        model=args.model,
        prompt=args.prompt,
        out_dir=args.out_dir,
        filename_prefix=args.filename_prefix,
        params=build_params(args),
    )

    if args.print_json:
        print(json.dumps(response, indent=2))

    for path in response.get("outputs", []):
        print(path)


if __name__ == "__main__":
    main()

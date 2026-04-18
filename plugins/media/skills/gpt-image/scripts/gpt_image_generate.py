#!/usr/bin/env python3
"""
Minimal OpenAI Images API wrapper for gpt-image-1.5.

Usage:
  OPENAI_API_KEY=... python3 gpt_image_generate.py \
    --prompt "Glass potion bottle icon, transparent background" \
    --out-dir tmp/potion
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


API_URL = "https://api.openai.com/v1/images/generations"
VALID_SIZES = {"1024x1024", "1024x1536", "1536x1024", "auto"}
VALID_QUALITIES = {"low", "medium", "high", "auto"}
VALID_FORMATS = {"png", "webp", "jpeg"}
VALID_BACKGROUNDS = {"transparent", "opaque", "auto"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate images with OpenAI gpt-image-1.5.")
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
    parser.add_argument("--print-json", action="store_true", help="Print the raw JSON response.")
    return parser.parse_args()


def ensure_supported_settings(args: argparse.Namespace) -> None:
    if args.background == "transparent" and args.output_format not in {"png", "webp"}:
        raise SystemExit("transparent background requires --output-format png or webp")
    if args.n < 1:
        raise SystemExit("--n must be >= 1")


def get_api_key() -> str:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is required")
    return api_key


def build_payload(args: argparse.Namespace) -> dict[str, object]:
    payload: dict[str, object] = {
        "model": args.model,
        "prompt": args.prompt,
        "n": args.n,
        "size": args.size,
        "quality": args.quality,
        "output_format": args.output_format,
        "background": args.background,
    }
    if args.user:
        payload["user"] = args.user
    return payload


def send_request(api_key: str, payload: dict[str, object]) -> dict[str, object]:
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"OpenAI API error {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error: {exc}") from exc
    return json.loads(body)


def suffix_for_format(output_format: str) -> str:
    guessed = mimetypes.guess_extension(f"image/{output_format}")
    if guessed:
        return guessed
    return f".{output_format}"


def write_images(response: dict[str, object], out_dir: Path, filename_prefix: str, output_format: str) -> list[Path]:
    data = response.get("data")
    if not isinstance(data, list) or not data:
        raise SystemExit("No image data returned by the API")

    out_dir.mkdir(parents=True, exist_ok=True)
    extension = suffix_for_format(output_format)
    written: list[Path] = []

    for index, item in enumerate(data, start=1):
        if not isinstance(item, dict) or "b64_json" not in item:
            raise SystemExit("Response did not contain b64_json image data")
        image_bytes = base64.b64decode(item["b64_json"])
        path = out_dir / f"{filename_prefix}-{index}{extension}"
        path.write_bytes(image_bytes)
        written.append(path)

    return written


def main() -> None:
    args = parse_args()
    ensure_supported_settings(args)
    api_key = get_api_key()
    payload = build_payload(args)
    response = send_request(api_key, payload)
    written = write_images(response, args.out_dir, args.filename_prefix, args.output_format)

    if args.print_json:
        print(json.dumps(response, indent=2))

    for path in written:
        print(path)


if __name__ == "__main__":
    main()

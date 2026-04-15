#!/usr/bin/env python3
"""
Minimal OpenAI Images API edit wrapper for gpt-image-1.5.

Usage:
  OPENAI_API_KEY=... python3 gpt_image_edit.py \
    --image input.png \
    --prompt "Keep the same sprite, raise the arm slightly" \
    --out-dir tmp/edit

  OPENAI_API_KEY=... python3 gpt_image_edit.py \
    --image identity.png \
    --image motion-guide.png \
    --input-fidelity high \
    --prompt "Use image 1 for identity and image 2 for pose" \
    --out-dir tmp/edit
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4


API_URL = "https://api.openai.com/v1/images/edits"
VALID_SIZES = {"1024x1024", "1024x1536", "1536x1024", "auto"}
VALID_QUALITIES = {"low", "medium", "high", "auto"}
VALID_FORMATS = {"png", "webp", "jpeg"}
VALID_BACKGROUNDS = {"transparent", "opaque", "auto"}
VALID_INPUT_FIDELITIES = {"low", "high"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Edit images with OpenAI gpt-image-1.5.")
    parser.add_argument(
        "--image",
        type=Path,
        action="append",
        required=True,
        help="Source image for the edit request. Repeat --image to send multiple references.",
    )
    parser.add_argument("--mask", type=Path, default=None, help="Optional mask image.")
    parser.add_argument("--prompt", required=True, help="Text prompt describing the edit.")
    parser.add_argument("--model", default="gpt-image-1.5", help="Model name. Defaults to gpt-image-1.5.")
    parser.add_argument("--out-dir", type=Path, required=True, help="Directory where edited images will be written.")
    parser.add_argument("--filename-prefix", default="image-edit", help="Prefix for output filenames.")
    parser.add_argument("--n", type=int, default=1, help="Number of images to request.")
    parser.add_argument("--size", default="1024x1024", choices=sorted(VALID_SIZES))
    parser.add_argument("--quality", default="medium", choices=sorted(VALID_QUALITIES))
    parser.add_argument("--output-format", default="png", choices=sorted(VALID_FORMATS))
    parser.add_argument("--background", default="transparent", choices=sorted(VALID_BACKGROUNDS))
    parser.add_argument(
        "--input-fidelity",
        default=None,
        choices=sorted(VALID_INPUT_FIDELITIES),
        help="Optional input fidelity setting for GPT Image edits.",
    )
    parser.add_argument("--user", default=None, help="Optional user identifier for tracing.")
    parser.add_argument("--print-json", action="store_true", help="Print the raw JSON response.")
    return parser.parse_args()


def ensure_supported_settings(args: argparse.Namespace) -> None:
    for image in args.image:
        if not image.exists():
            raise SystemExit(f"Source image not found: {image}")
    if args.mask is not None and not args.mask.exists():
        raise SystemExit(f"Mask image not found: {args.mask}")
    if args.background == "transparent" and args.output_format not in {"png", "webp"}:
        raise SystemExit("transparent background requires --output-format png or webp")
    if args.n < 1:
        raise SystemExit("--n must be >= 1")


def get_api_key() -> str:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is required")
    return api_key


def multipart_body(args: argparse.Namespace) -> tuple[bytes, str]:
    boundary = f"----CodexOpenAIBoundary{uuid4().hex}"
    body = bytearray()

    def add_text(name: str, value: str) -> None:
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        body.extend(value.encode("utf-8"))
        body.extend(b"\r\n")

    def add_file(name: str, path: Path) -> None:
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(
            f'Content-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'.encode("utf-8")
        )
        body.extend(f"Content-Type: {mime}\r\n\r\n".encode("utf-8"))
        body.extend(path.read_bytes())
        body.extend(b"\r\n")

    add_text("model", args.model)
    add_text("prompt", args.prompt)
    add_text("n", str(args.n))
    add_text("size", args.size)
    add_text("quality", args.quality)
    add_text("output_format", args.output_format)
    add_text("background", args.background)
    if args.user:
        add_text("user", args.user)

    for image in args.image:
        add_file("image[]", image)
    if args.mask is not None:
        add_file("mask", args.mask)
    if args.input_fidelity is not None:
        add_text("input_fidelity", args.input_fidelity)

    body.extend(f"--{boundary}--\r\n".encode("utf-8"))
    return bytes(body), boundary


def send_request(api_key: str, args: argparse.Namespace) -> dict[str, object]:
    body, boundary = multipart_body(args)
    request = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            payload = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"OpenAI API error {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error: {exc}") from exc
    return json.loads(payload)


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
    response = send_request(api_key, args)
    written = write_images(response, args.out_dir, args.filename_prefix, args.output_format)

    if args.print_json:
        print(json.dumps(response, indent=2))

    for path in written:
        print(path)


if __name__ == "__main__":
    main()

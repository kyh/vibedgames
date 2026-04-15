#!/usr/bin/env python3
"""
Minimal OpenAI Videos API wrapper for sora-2.

Creates a video job, optionally polls until completion, and downloads the
resulting file.

Usage:
  OPENAI_API_KEY=... python3 sora_video_generate.py \
    --prompt "A paper lantern drifting over a river at dusk." \
    --out-dir tmp/sora --seconds 4

  OPENAI_API_KEY=... python3 sora_video_generate.py \
    --prompt "Animate this product photo into a slow reveal." \
    --image-file ./reference.png \
    --out-dir tmp/sora --size 720x1280 --seconds 4
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4


API_ROOT = "https://api.openai.com/v1"
CREATE_URL = f"{API_ROOT}/videos"
VALID_SIZES = {"1280x720", "720x1280"}
VALID_SECONDS = {4, 8, 12}
SUCCESS_STATUSES = {"completed", "succeeded"}
FAILURE_STATUSES = {"failed", "cancelled", "canceled"}
TERMINAL_STATUSES = SUCCESS_STATUSES | FAILURE_STATUSES


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate videos with OpenAI sora-2.")
    parser.add_argument("--prompt", required=True, help="Prompt describing the video.")
    parser.add_argument("--model", default="sora-2", help="Model name. Defaults to sora-2.")
    parser.add_argument("--image-url", default=None, help="Optional image URL for image-guided generation.")
    parser.add_argument("--image-file", type=Path, default=None, help="Optional local image file for image-guided generation.")
    parser.add_argument("--size", default="720x1280", choices=sorted(VALID_SIZES))
    parser.add_argument("--seconds", type=int, default=4, choices=sorted(VALID_SECONDS))
    parser.add_argument("--out-dir", type=Path, required=True, help="Directory where job JSON and video will be written.")
    parser.add_argument("--filename-prefix", default="sora-video", help="Prefix for output files.")
    parser.add_argument("--poll-interval", type=float, default=10.0, help="Seconds between job status checks.")
    parser.add_argument("--timeout", type=int, default=900, help="Maximum seconds to wait for completion.")
    parser.add_argument("--user", default=None, help="Optional user identifier for tracing.")
    parser.add_argument("--no-wait", action="store_true", help="Create the job and exit without polling.")
    parser.add_argument("--no-download", action="store_true", help="Poll for completion but skip content download.")
    parser.add_argument("--print-json", action="store_true", help="Print the raw JSON response(s).")
    return parser.parse_args()


def get_api_key() -> str:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is required")
    return api_key


def data_url_for_file(path: Path) -> str:
    if not path.exists():
        raise SystemExit(f"Image file not found: {path}")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def json_request(method: str, url: str, api_key: str, payload: dict[str, object] | None = None) -> dict[str, object]:
    data = None
    headers = {"Authorization": f"Bearer {api_key}"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"OpenAI API error {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error: {exc}") from exc

    return json.loads(body)


def multipart_request(url: str, api_key: str, fields: dict[str, str], files: list[tuple[str, Path]]) -> dict[str, object]:
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
        body.extend(f'Content-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'.encode("utf-8"))
        body.extend(f"Content-Type: {mime}\r\n\r\n".encode("utf-8"))
        body.extend(path.read_bytes())
        body.extend(b"\r\n")

    for name, value in fields.items():
        add_text(name, value)
    for name, path in files:
        add_file(name, path)

    body.extend(f"--{boundary}--\r\n".encode("utf-8"))

    request = urllib.request.Request(
        url,
        data=bytes(body),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            body_text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"OpenAI API error {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error: {exc}") from exc
    return json.loads(body_text)


def download_bytes(url: str, api_key: str) -> tuple[bytes, str]:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"}, method="GET")
    try:
        with urllib.request.urlopen(request) as response:
            content_type = response.headers.get("Content-Type", "application/octet-stream")
            return response.read(), content_type
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"OpenAI API error {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error: {exc}") from exc


def save_json(path: Path, payload: dict[str, object]) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def video_extension(content_type: str) -> str:
    if "mp4" in content_type:
        return ".mp4"
    if "quicktime" in content_type or "mov" in content_type:
        return ".mov"
    return ".mp4"


def create_video(api_key: str, args: argparse.Namespace) -> dict[str, object]:
    if args.image_url and args.image_file is not None:
        raise SystemExit("Use only one of --image-url or --image-file")
    if args.image_file is not None:
        fields = {
            "model": args.model,
            "prompt": args.prompt,
            "size": args.size,
            "seconds": str(args.seconds),
        }
        if args.user:
            fields["user"] = args.user
        return multipart_request(CREATE_URL, api_key, fields, [("input_reference", args.image_file)])

    payload: dict[str, object] = {
        "model": args.model,
        "prompt": args.prompt,
        "size": args.size,
        "seconds": str(args.seconds),
    }
    if args.image_url:
        payload["image_reference"] = {"image_url": args.image_url}
    if args.user:
        payload["user"] = args.user
    return json_request("POST", CREATE_URL, api_key, payload)


def poll_video(api_key: str, video_id: str, interval_seconds: float, timeout_seconds: int) -> dict[str, object]:
    deadline = time.time() + timeout_seconds
    status_url = f"{CREATE_URL}/{video_id}"

    while True:
        response = json_request("GET", status_url, api_key)
        status = str(response.get("status", "")).lower()
        if status in TERMINAL_STATUSES:
            return response

        if time.time() >= deadline:
            raise SystemExit(f"Timed out waiting for video {video_id} to complete")

        time.sleep(interval_seconds)


def require_video_id(response: dict[str, object]) -> str:
    video_id = response.get("id")
    if not isinstance(video_id, str) or not video_id:
        raise SystemExit("API response did not include a video id")
    return video_id


def main() -> None:
    args = parse_args()
    api_key = get_api_key()

    args.out_dir.mkdir(parents=True, exist_ok=True)

    created = create_video(api_key, args)
    video_id = require_video_id(created)
    create_json_path = args.out_dir / f"{args.filename_prefix}-create.json"
    save_json(create_json_path, created)

    if args.print_json:
        print(json.dumps(created, indent=2))

    print(video_id)
    print(create_json_path)

    if args.no_wait:
        return

    final = poll_video(api_key, video_id, args.poll_interval, args.timeout)
    final_json_path = args.out_dir / f"{args.filename_prefix}-final.json"
    save_json(final_json_path, final)

    if args.print_json:
        print(json.dumps(final, indent=2))

    status = str(final.get("status", "")).lower()
    print(final_json_path)

    if status not in SUCCESS_STATUSES:
        failure_reason = final.get("failure_reason") or final.get("error") or "unknown failure"
        raise SystemExit(f"Video job {video_id} finished with status '{status}': {failure_reason}")

    if args.no_download:
        return

    content_url = f"{CREATE_URL}/{video_id}/content"
    video_bytes, content_type = download_bytes(content_url, api_key)
    extension = video_extension(content_type)
    video_path = args.out_dir / f"{args.filename_prefix}{extension}"
    video_path.write_bytes(video_bytes)
    print(video_path)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("Interrupted")

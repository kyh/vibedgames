#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import base64
import hashlib
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image


API_ROOT = "https://api.retrodiffusion.ai/v1"
SKILL_DIR = Path(__file__).resolve().parents[1]


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def relative_path(path: Path) -> str:
    """Return a relative path string from the current working directory."""
    try:
        return path.resolve().relative_to(Path.cwd()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def prompt_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def require_rd_key() -> str:
    value = os.environ.get("RETRO_DIFFUSION_API_KEY") or os.environ.get("RD_API_KEY")
    if not value:
        raise SystemExit("Set RETRO_DIFFUSION_API_KEY or RD_API_KEY in the environment.")
    return value


def load_presets() -> dict[str, Any]:
    path = SKILL_DIR / "assets/model-presets.json"
    return json.loads(path.read_text(encoding="utf-8"))


def base64_rgb_png(path: Path) -> str:
    from io import BytesIO

    with Image.open(path) as image:
        rgb = image.convert("RGB")
        buffer = BytesIO()
        rgb.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def json_request(url: str, payload: dict[str, Any], api_key: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-RD-Token": api_key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Retro Diffusion request failed ({exc.code}): {body}") from exc


def media_extension(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    return ".bin"


def decode_base64_media(data: str) -> bytes:
    return base64.b64decode(data)

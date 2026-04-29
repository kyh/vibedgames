#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image


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


def load_presets() -> dict[str, Any]:
    path = SKILL_DIR / "assets/model-presets.json"
    return json.loads(path.read_text(encoding="utf-8"))


def base64_rgb_png(path: Path) -> str:
    """
    Encode an image as a base64 RGB PNG string for the Retro Diffusion API.
    Transparency is flattened — the API requires RGB references, not RGBA.
    """
    from io import BytesIO

    with Image.open(path) as image:
        rgb = image.convert("RGB")
        buffer = BytesIO()
        rgb.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")

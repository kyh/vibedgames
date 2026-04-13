#!/usr/bin/env python3
from __future__ import annotations

import base64
import csv
import hashlib
import json
import mimetypes
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


QUEUE_ROOT = "https://queue.fal.run"
PLATFORM_ROOT = "https://api.fal.ai/v1"
REPO_ROOT = Path(__file__).resolve().parents[4]
SKILL_ROOT = Path(__file__).resolve().parents[1]
PRESETS_PATH = SKILL_ROOT / "assets" / "model-presets.json"


@dataclass
class HttpJsonResponse:
    status_code: int
    headers: dict[str, str]
    payload: dict[str, Any]


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def timestamp_slug() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")


def require_fal_key() -> str:
    api_key = os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY")
    if not api_key:
        raise SystemExit("FAL_KEY or FAL_API_KEY is required")
    return api_key


def load_presets() -> dict[str, dict[str, Any]]:
    return json.loads(PRESETS_PATH.read_text(encoding="utf-8"))


def prompt_sha256(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, payload: Any) -> None:
    ensure_parent(path)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    ensure_parent(path)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    ensure_parent(path)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({name: row.get(name, "") for name in fieldnames})


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped:
            rows.append(json.loads(stripped))
    return rows


def normalize_headers(headers: Any) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for key, value in headers.items():
        normalized[str(key).lower()] = str(value)
    return normalized


def fal_headers(api_key: str, extra_headers: dict[str, str] | None = None, *, json_content: bool = False) -> dict[str, str]:
    headers = {
        "Authorization": f"Key {api_key}",
        "Accept": "application/json",
    }
    if json_content:
        headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)
    return headers


def data_uri_for_file(path: Path) -> str:
    if not path.exists():
        raise SystemExit(f"Image file not found: {path}")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _json_request(method: str, url: str, api_key: str, payload: Any | None = None, headers: dict[str, str] | None = None) -> HttpJsonResponse:
    request_headers = fal_headers(api_key, headers, json_content=payload is not None)
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read().decode("utf-8")
            response_headers = normalize_headers(response.headers)
            parsed = json.loads(body) if body else {}
            return HttpJsonResponse(response.getcode(), response_headers, parsed)
    except urllib.error.HTTPError as exc:
        error_text = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"fal API error {exc.code}: {error_text}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error: {exc}") from exc


def queue_submit(endpoint_id: str, api_key: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> HttpJsonResponse:
    return _json_request("POST", f"{QUEUE_ROOT}/{endpoint_id.strip('/')}", api_key, payload=payload, headers=headers)


def queue_get_by_url(url: str, api_key: str, headers: dict[str, str] | None = None, *, query: dict[str, Any] | None = None) -> HttpJsonResponse:
    encoded_query = ""
    if query:
        items: list[tuple[str, str]] = []
        for key, value in query.items():
            if value is None:
                continue
            if isinstance(value, list):
                for item in value:
                    items.append((key, str(item)))
            else:
                items.append((key, str(value)))
        encoded_query = f"?{urllib.parse.urlencode(items)}" if items else ""
    return _json_request("GET", f"{url}{encoded_query}", api_key, headers=headers)


def queue_status(endpoint_id: str, request_id: str, api_key: str, headers: dict[str, str] | None = None, *, logs: bool = True) -> HttpJsonResponse:
    query = "?logs=1" if logs else ""
    return _json_request(
        "GET",
        f"{QUEUE_ROOT}/{endpoint_id.strip('/')}/requests/{request_id}/status{query}",
        api_key,
        headers=headers,
    )


def queue_result(endpoint_id: str, request_id: str, api_key: str, headers: dict[str, str] | None = None) -> HttpJsonResponse:
    return _json_request(
        "GET",
        f"{QUEUE_ROOT}/{endpoint_id.strip('/')}/requests/{request_id}",
        api_key,
        headers=headers,
    )


def platform_get(path: str, api_key: str, query: dict[str, Any] | None = None) -> HttpJsonResponse:
    encoded_query = ""
    if query:
        items: list[tuple[str, str]] = []
        for key, value in query.items():
            if value is None:
                continue
            if isinstance(value, list):
                for item in value:
                    items.append((key, str(item)))
            else:
                items.append((key, str(value)))
        encoded_query = f"?{urllib.parse.urlencode(items)}" if items else ""
    return _json_request("GET", f"{PLATFORM_ROOT}{path}{encoded_query}", api_key)


def platform_post(path: str, api_key: str, payload: dict[str, Any]) -> HttpJsonResponse:
    return _json_request("POST", f"{PLATFORM_ROOT}{path}", api_key, payload=payload)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def repo_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def download_file(url: str, out_path: Path) -> None:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request) as response:
            ensure_parent(out_path)
            out_path.write_bytes(response.read())
    except urllib.error.HTTPError as exc:
        error_text = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Download failed {exc.code}: {error_text}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Download failed: {exc}") from exc


def _walk_media(value: Any, path: str = "") -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        if isinstance(value.get("url"), str):
            found.append(
                {
                    "path": path or "url",
                    "url": value["url"],
                    "content_type": value.get("content_type"),
                    "file_name": value.get("file_name"),
                }
            )
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            found.extend(_walk_media(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_path = f"{path}[{index}]"
            found.extend(_walk_media(child, child_path))
    return found


def collect_media_outputs(payload: dict[str, Any]) -> list[dict[str, Any]]:
    return _walk_media(payload)


def default_platform_headers(*, store_io: bool = True, disable_fallback: bool = True) -> dict[str, str]:
    headers: dict[str, str] = {}
    if store_io:
        headers["X-Fal-Store-IO"] = "1"
    if disable_fallback:
        headers["x-app-fal-disable-fallback"] = "true"
    return headers


def build_unit_price_estimate_payload(endpoint_id: str, unit_quantity: float) -> dict[str, Any]:
    return {
        "estimate_type": "unit_price",
        "endpoints": {
            endpoint_id: {
                "unit_quantity": unit_quantity,
            }
        },
    }


def coerce_json_object(text: str | None) -> dict[str, Any]:
    if not text:
        return {}
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise SystemExit("Expected a JSON object")
    return payload


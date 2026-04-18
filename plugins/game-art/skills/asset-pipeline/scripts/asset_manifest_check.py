# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Verify that all PNGs are referenced by the asset manifest and vice versa.

Usage:
  uv run path/to/asset_manifest_check.py
  uv run path/to/asset_manifest_check.py --manifest path/to/assets_index.lua --root assets
  uv run path/to/asset_manifest_check.py --manifest path/to/assets_index.lua --root path/to/assets --json tmp/check.json
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


# Extract paths from Lua entries like: path = "assets/foo/bar.png"
# Keep this generic so the script works for other projects/roots too.
PATH_RE = re.compile(r'path\s*=\s*"([^"]+\.png)"')


def _resolve_manifest_path(raw: str, *, manifest_dir: Path, json_root: str | None) -> Path:
    p = Path(raw)
    if p.is_absolute():
        return p.resolve()

    if json_root:
        return (manifest_dir / json_root / p).resolve()
    return (manifest_dir / p).resolve()


def _extract_json_paths(payload: Any) -> list[str]:
    paths: list[str] = []
    if isinstance(payload, dict):
        for k, v in payload.items():
            if k == "path" and isinstance(v, str) and v.lower().endswith(".png"):
                paths.append(v)
            else:
                paths.extend(_extract_json_paths(v))
    elif isinstance(payload, list):
        for v in payload:
            paths.extend(_extract_json_paths(v))
    return paths


def extract_manifest_paths(manifest_path: Path) -> set[Path]:
    if manifest_path.suffix.lower() == ".json":
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise SystemExit("JSON manifest must be an object at top-level.")
        manifest_dir = manifest_path.parent.resolve()
        meta = payload.get("meta") if isinstance(payload, dict) else None
        json_root = meta.get("root") if isinstance(meta, dict) and isinstance(meta.get("root"), str) else None
        return {
            _resolve_manifest_path(p, manifest_dir=manifest_dir, json_root=json_root)
            for p in _extract_json_paths(payload)
        }

    # Fallback: Lua (or anything text-ish) via regex
    text = manifest_path.read_text(encoding="utf-8")
    manifest_dir = manifest_path.parent.resolve()
    return {_resolve_manifest_path(p, manifest_dir=manifest_dir, json_root=None) for p in PATH_RE.findall(text)}


def list_actual_pngs(root: Path) -> set[Path]:
    return {p.resolve() for p in root.rglob("*.png")}


def _pretty(p: Path) -> str:
    try:
        return str(p.relative_to(Path.cwd().resolve()))
    except Exception:
        return str(p)


def main() -> None:
    parser = argparse.ArgumentParser(description="Check manifest coverage for assets.")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Path to the Lua asset manifest (default: auto-detect common names).",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Root folder to scan for PNGs (default: ./assets if it exists else .).",
    )
    parser.add_argument(
        "--json",
        type=Path,
        default=None,
        help="Optional JSON output path.",
    )
    args = parser.parse_args()

    root: Path = args.root if args.root is not None else (Path("assets") if Path("assets").exists() else Path("."))
    if not root.exists():
        raise SystemExit(f"Root not found: {root}")

    manifest_candidates = [
        Path("assets_index.lua"),
        Path("asset_index.lua"),
        Path("assets/assets_index.lua"),
        Path("assets/asset_index.lua"),
    ]
    manifest: Path | None = args.manifest
    if manifest is None:
        manifest = next((p for p in manifest_candidates if p.exists()), None)
    if manifest is None or not manifest.exists():
        raise SystemExit(
            "Manifest not found. Pass --manifest or create one of: "
            + ", ".join(str(p) for p in manifest_candidates)
        )

    manifest_paths = extract_manifest_paths(manifest)
    actual_paths = list_actual_pngs(root)

    missing = sorted(actual_paths - manifest_paths, key=_pretty)
    extra = sorted(manifest_paths - actual_paths, key=_pretty)

    print(f"manifest paths: {len(manifest_paths)}")
    print(f"actual pngs:    {len(actual_paths)}")
    print(f"missing:        {len(missing)}")
    for path in missing:
        print(f"  MISSING {_pretty(path)}")
    print(f"extra:          {len(extra)}")
    for path in extra:
        print(f"  EXTRA {_pretty(path)}")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "manifest_paths": len(manifest_paths),
            "actual_pngs": len(actual_paths),
            "missing": [_pretty(p) for p in missing],
            "extra": [_pretty(p) for p in extra],
        }
        with args.json.open("w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)


if __name__ == "__main__":
    main()

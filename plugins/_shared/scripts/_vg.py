"""
Thin Python wrapper around `vg image generate/edit --json`.

Skills shell out to the vibedgames CLI so users do not need provider API
keys; the platform holds them. The CLI must be installed and the user
authenticated (`vg login`).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Sequence


def _vg_binary() -> str:
    override = os.environ.get("VG_BIN")
    if override:
        return override
    found = shutil.which("vg")
    if found:
        return found
    raise SystemExit(
        "vg CLI not found on PATH. Install with `npm i -g vibedgames` or set VG_BIN."
    )


def run_vg_image(
    *,
    task: str,
    provider: str,
    model: str,
    prompt: str,
    out_dir: Path,
    filename_prefix: str,
    params: dict[str, Any] | None = None,
    images: Sequence[Path] = (),
) -> dict[str, Any]:
    """
    Invoke `vg image <task>` and return the parsed JSON response.

    The CLI downloads any generated image files into ``out_dir`` and prints
    a JSON object describing the run; the caller is responsible for any
    additional bookkeeping (manifests, ledgers, etc.).
    """
    if task not in {"generate", "edit"}:
        raise SystemExit(f"unsupported vg image task: {task}")

    cmd: list[str] = [
        _vg_binary(),
        "image",
        task,
        "--provider",
        provider,
        "--model",
        model,
        "--prompt",
        prompt,
        "--out-dir",
        str(out_dir),
        "--filename-prefix",
        filename_prefix,
        "--json",
    ]
    
    params_file = None
    try:
        if params:
            params_json = json.dumps(params)
            if len(params_json) > 32000:
                with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
                    json.dump(params, f)
                    params_file = f.name
                cmd.extend(["--params-file", params_file])
            else:
                cmd.extend(["--params", params_json])
        
        for image in images:
            cmd.extend(["--image", str(image)])

        completed = subprocess.run(cmd, capture_output=True, text=True)
        if completed.returncode != 0:
            stderr = completed.stderr.strip() or completed.stdout.strip()
            raise SystemExit(f"vg image {task} failed: {stderr}")
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise SystemExit(
                f"vg image {task} returned non-JSON output: {completed.stdout!r}"
            ) from exc
    finally:
        if params_file:
            try:
                os.unlink(params_file)
            except OSError:
                pass

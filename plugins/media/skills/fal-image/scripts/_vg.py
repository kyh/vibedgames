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

    `params` is always passed via `--params-file` so embedded base64 images
    or other large fields cannot blow past the OS argv length limit.
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
    for image in images:
        cmd.extend(["--image", str(image)])

    params_file: tempfile._TemporaryFileWrapper | None = None
    try:
        if params:
            params_file = tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", delete=False, encoding="utf-8"
            )
            json.dump(params, params_file)
            params_file.flush()
            params_file.close()
            cmd.extend(["--params-file", params_file.name])

        completed = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        if params_file is not None:
            try:
                os.unlink(params_file.name)
            except OSError:
                pass

    if completed.returncode != 0:
        stderr = completed.stderr.strip() or completed.stdout.strip()
        raise SystemExit(f"vg image {task} failed: {stderr}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"vg image {task} returned non-JSON output: {completed.stdout!r}"
        ) from exc

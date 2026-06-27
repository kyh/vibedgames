#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "numpy>=1.26",
#   "pillow>=10.0",
# ]
# ///
"""Spritesheet-aware variant of pixel_snapper.py.

Takes a sheet whose layout (cols, rows) is known, crops it into frames, snaps
all frames to ONE shared pixel grid, and reassembles a fresh sheet.

Why crop first, then snap together: pixel_snapper.py assumes a single grid pitch
across the whole image, but a raw sheet has two competing scales (frame size and
intra-frame pixel cell) that confuse step-size detection. Cropping to frames
removes the frame-grid scale; tight-packing the crops into one strip and snapping
that strip once leaves a single intra-frame pitch to recover — so every frame
ends up the same scale (no size drift between frames) without any lossy
per-frame re-cropping.

Algorithm and parameter defaults are by Hugo Duprez (MIT) — see the
parent skill's references/credits.md.

Usage:
  uv run scripts/pixel_snapper_sheet.py input.png output.png \\
    --cols 6 --rows 1 [--k-colors 256]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

from pixel_snapper import (
    Config,
    compute_profiles,
    estimate_step_size,
    quantize,
    resample,
    resolve_step_sizes,
    sanitize_cuts,
    walk,
)


def snap_array(rgba: np.ndarray, cfg: Config) -> np.ndarray:
    """Run the full snap pipeline on one RGBA array (quantize -> profile -> step ->
    walk -> resample) and return the snapped array at its discovered native size."""
    h, w, _ = rgba.shape
    img = quantize(rgba, cfg)
    col_proj, row_proj = compute_profiles(img)
    step_x, step_y = resolve_step_sizes(
        estimate_step_size(col_proj, cfg), estimate_step_size(row_proj, cfg), w, h, cfg
    )
    col_cuts = sanitize_cuts(walk(col_proj, step_x, w, cfg), w)
    row_cuts = sanitize_cuts(walk(row_proj, step_y, h, cfg), h)
    return resample(img, col_cuts, row_cuts)


def snap_sheet(input_path: Path, output_path: Path, cols: int, rows: int, cfg: Config) -> dict:
    rgba = np.array(Image.open(input_path).convert("RGBA"))
    H, W, _ = rgba.shape
    if W % cols != 0 or H % rows != 0:
        raise SystemExit(
            f"Sheet {W}x{H} is not divisible by cols={cols} rows={rows}; "
            f"frames would be non-integer dimensions."
        )
    fw, fh = W // cols, H // rows
    n = cols * rows

    # Crop frames (row-major) and lay them in one tight strip, then snap once so the
    # snapper finds a single shared pitch for every frame.
    crops = [rgba[r * fh:(r + 1) * fh, c * fw:(c + 1) * fw] for r in range(rows) for c in range(cols)]
    snapped = snap_array(np.concatenate(crops, axis=1), cfg)
    sh, sw, _ = snapped.shape
    tw = sw // n  # shared native frame width; trailing remainder columns are empty margin

    out = np.zeros((sh * rows, tw * cols, 4), dtype=np.uint8)
    for idx in range(n):
        r, c = divmod(idx, cols)
        out[r * sh:(r + 1) * sh, c * tw:(c + 1) * tw] = snapped[:, idx * tw:(idx + 1) * tw]
    Image.fromarray(out, mode="RGBA").save(output_path)
    return {
        "input_dims": (W, H),
        "input_frame_dims": (fw, fh),
        "target_frame_dims": (tw, sh),
        "output_dims": (tw * cols, sh * rows),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cols", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--k-colors", type=int, default=256)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.cols <= 0 or args.rows <= 0:
        raise SystemExit("--cols and --rows must be positive integers")
    if args.k_colors <= 0:
        raise SystemExit("--k-colors must be a positive integer")
    cfg = Config(k_colors=args.k_colors, k_seed=args.seed)
    info = snap_sheet(args.input, args.output, args.cols, args.rows, cfg)
    fw, fh = info["target_frame_dims"]
    ow, oh = info["output_dims"]
    print(f"Snapped sheet {args.input} -> {args.output}")
    print(f"  input: {info['input_dims'][0]}x{info['input_dims'][1]} "
          f"({args.cols}x{args.rows} of {info['input_frame_dims'][0]}x{info['input_frame_dims'][1]})")
    print(f"  target frame: {fw}x{fh} (shared pitch across all frames)")
    print(f"  output: {ow}x{oh}")


if __name__ == "__main__":
    main()

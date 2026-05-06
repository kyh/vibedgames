#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "numpy>=1.26",
#   "pillow>=10.0",
# ]
# ///
"""Spritesheet-aware variant of pixel_snapper.py.

Takes a sheet whose layout (cols, rows) is known, splits into per-frame
crops, snaps each frame to its discovered pixel grid, then reassembles
onto a fresh sheet at the most-common snapped frame size.

Why: pixel_snapper.py runs the full pipeline globally and assumes one
consistent grid pitch across the whole image. Spritesheets have two
relevant scales (frame size and intra-frame pixel cell) that compete
during step-size detection. Cropping to frames first sidesteps that.

Algorithm and parameter defaults are by Hugo Duprez (MIT) — see the
parent skill's references/credits.md.

Usage:
  uv run scripts/pixel_snapper_sheet.py input.png output.png \\
    --cols 6 --rows 1 [--k-colors 256] [--shared-palette]
"""

from __future__ import annotations

import argparse
from collections import Counter
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


def snap_frame(rgba: np.ndarray, cfg: Config, pre_quantized: bool) -> np.ndarray:
    """Snap a single already-cropped frame. If pre_quantized, skip per-frame k-means."""
    h, w, _ = rgba.shape
    img = rgba if pre_quantized else quantize(rgba, cfg)
    col_proj, row_proj = compute_profiles(img)
    sx = estimate_step_size(col_proj, cfg)
    sy = estimate_step_size(row_proj, cfg)
    step_x, step_y = resolve_step_sizes(sx, sy, w, h, cfg)
    col_cuts = sanitize_cuts(walk(col_proj, step_x, w, cfg), w)
    row_cuts = sanitize_cuts(walk(row_proj, step_y, h, cfg), h)
    return resample(img, col_cuts, row_cuts)


def normalize_to_canvas(frame: np.ndarray, target_h: int, target_w: int) -> np.ndarray:
    """Center frame on a transparent canvas of (target_h, target_w). Crop if larger."""
    h, w, _ = frame.shape
    canvas = np.zeros((target_h, target_w, 4), dtype=np.uint8)
    src_y0 = max(0, (h - target_h) // 2)
    src_x0 = max(0, (w - target_w) // 2)
    use_h = min(h, target_h)
    use_w = min(w, target_w)
    dst_y0 = max(0, (target_h - h) // 2)
    dst_x0 = max(0, (target_w - w) // 2)
    canvas[dst_y0:dst_y0 + use_h, dst_x0:dst_x0 + use_w] = (
        frame[src_y0:src_y0 + use_h, src_x0:src_x0 + use_w]
    )
    return canvas


def snap_sheet(
    input_path: Path,
    output_path: Path,
    cols: int,
    rows: int,
    cfg: Config,
    shared_palette: bool,
) -> dict:
    img = Image.open(input_path).convert("RGBA")
    rgba = np.array(img)
    H, W, _ = rgba.shape
    if W % cols != 0 or H % rows != 0:
        raise SystemExit(
            f"Sheet {W}x{H} is not divisible by cols={cols} rows={rows}; "
            f"frames would be non-integer dimensions."
        )
    frame_w = W // cols
    frame_h = H // rows

    source = quantize(rgba, cfg) if shared_palette else rgba

    snapped_frames: list[np.ndarray] = []
    for r in range(rows):
        for c in range(cols):
            crop = source[r * frame_h:(r + 1) * frame_h, c * frame_w:(c + 1) * frame_w]
            snapped = snap_frame(crop, cfg, pre_quantized=shared_palette)
            snapped_frames.append(snapped)

    dims = [(f.shape[0], f.shape[1]) for f in snapped_frames]
    most_common_dim, _ = Counter(dims).most_common(1)[0]
    target_h, target_w = most_common_dim

    aligned = [normalize_to_canvas(f, target_h, target_w) for f in snapped_frames]

    out_h = target_h * rows
    out_w = target_w * cols
    out = np.zeros((out_h, out_w, 4), dtype=np.uint8)
    for idx, f in enumerate(aligned):
        r = idx // cols
        c = idx % cols
        out[r * target_h:(r + 1) * target_h, c * target_w:(c + 1) * target_w] = f

    Image.fromarray(out, mode="RGBA").save(output_path)
    return {
        "input_dims": (W, H),
        "input_frame_dims": (frame_w, frame_h),
        "per_frame_snapped_dims": dims,
        "target_frame_dims": (target_w, target_h),
        "output_dims": (out_w, out_h),
        "shared_palette": shared_palette,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cols", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--k-colors", type=int, default=256)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--shared-palette",
        action="store_true",
        help="Quantize the full sheet once before splitting (unified palette across frames).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cfg = Config(k_colors=args.k_colors, k_seed=args.seed)
    info = snap_sheet(args.input, args.output, args.cols, args.rows, cfg, args.shared_palette)
    fw, fh = info["target_frame_dims"]
    ow, oh = info["output_dims"]
    print(f"Snapped sheet {args.input} -> {args.output}")
    print(f"  input: {info['input_dims'][0]}x{info['input_dims'][1]} "
          f"({args.cols}x{args.rows} of {info['input_frame_dims'][0]}x{info['input_frame_dims'][1]})")
    print(f"  per-frame snapped dims: {info['per_frame_snapped_dims']}")
    print(f"  target frame: {fw}x{fh} (most common)")
    print(f"  output: {ow}x{oh}")


if __name__ == "__main__":
    main()

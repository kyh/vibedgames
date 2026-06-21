#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "numpy>=1.26",
#   "pillow>=10.0",
# ]
# ///
"""Python port of Hugo-Dz/spritefusion-pixel-snapper.

Recovers the underlying low-resolution pixel-art grid from an upscaled or
AI-generated image. Pipeline:

  1. K-means quantize the palette.
  2. Compute 1D edge-gradient profiles along x and y.
  3. Estimate the cell pitch as the median peak spacing per axis.
  4. Walk along each axis placing cuts that snap to nearby edge peaks.
  5. Resample: one output pixel per cell, picking the majority color.

Usage:
  uv run scripts/pixel_snapper.py input.png output.png [--k-colors 256]
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


@dataclass(frozen=True)
class Config:
    k_colors: int = 16
    k_seed: int = 42
    max_kmeans_iterations: int = 15
    peak_threshold_multiplier: float = 0.2
    peak_distance_filter: int = 4
    walker_search_window_ratio: float = 0.35
    walker_min_search_window: float = 2.0
    walker_strength_threshold: float = 0.5
    fallback_target_segments: int = 64
    max_step_ratio: float = 1.8


def quantize(rgba: np.ndarray, cfg: Config) -> np.ndarray:
    """K-means over opaque pixels, returns quantized RGBA."""
    h, w, _ = rgba.shape
    rgb = rgba[..., :3].astype(np.float32)
    alpha = rgba[..., 3]
    opaque_mask = alpha > 0
    opaque_pixels = rgb[opaque_mask]
    if opaque_pixels.size == 0:
        return rgba.copy()

    k = min(cfg.k_colors, len(opaque_pixels))
    rng = np.random.default_rng(cfg.k_seed)
    init_idx = rng.choice(len(opaque_pixels), size=k, replace=False)
    centers = opaque_pixels[init_idx].copy()

    for _ in range(cfg.max_kmeans_iterations):
        dists = np.sum((opaque_pixels[:, None, :] - centers[None, :, :]) ** 2, axis=2)
        labels = np.argmin(dists, axis=1)
        new_centers = np.empty_like(centers)
        moved = False
        for i in range(k):
            members = opaque_pixels[labels == i]
            if len(members) == 0:
                new_centers[i] = centers[i]
            else:
                new_centers[i] = members.mean(axis=0)
            if not np.allclose(new_centers[i], centers[i], atol=0.5):
                moved = True
        centers = new_centers
        if not moved:
            break

    quantized = rgba.copy()
    quantized_rgb = quantized[..., :3]
    flat_quantized_rgb = quantized_rgb.reshape(-1, 3)
    flat_alpha = alpha.reshape(-1)
    flat_opaque_mask = flat_alpha > 0
    opaque_quant = np.rint(centers[labels]).astype(np.uint8)
    flat_quantized_rgb[flat_opaque_mask] = opaque_quant
    return quantized


def compute_profiles(rgba: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-column and per-row edge-gradient sums, weighting transparent pixels as 0."""
    rgb = rgba[..., :3].astype(np.float64)
    alpha = rgba[..., 3]
    luma = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    luma[alpha == 0] = 0.0

    h, w = luma.shape
    if w < 3 or h < 3:
        raise ValueError("Image too small (minimum 3x3)")

    col_grad = np.abs(luma[:, 2:] - luma[:, :-2])
    col_proj = np.zeros(w, dtype=np.float64)
    col_proj[1:-1] = col_grad.sum(axis=0)

    row_grad = np.abs(luma[2:, :] - luma[:-2, :])
    row_proj = np.zeros(h, dtype=np.float64)
    row_proj[1:-1] = row_grad.sum(axis=1)

    return col_proj, row_proj


def estimate_step_size(profile: np.ndarray, cfg: Config) -> float | None:
    if profile.size == 0:
        return None
    max_val = float(profile.max())
    if max_val == 0.0:
        return None
    threshold = max_val * cfg.peak_threshold_multiplier

    peaks: list[int] = []
    for i in range(1, len(profile) - 1):
        v = profile[i]
        if v > threshold and v > profile[i - 1] and v > profile[i + 1]:
            peaks.append(i)
    if len(peaks) < 2:
        return None

    clean = [peaks[0]]
    for p in peaks[1:]:
        if p - clean[-1] > (cfg.peak_distance_filter - 1):
            clean.append(p)
    if len(clean) < 2:
        return None

    diffs = np.diff(clean)
    return float(np.median(diffs))


def resolve_step_sizes(
    sx: float | None, sy: float | None, w: int, h: int, cfg: Config
) -> tuple[float, float]:
    if sx is not None and sy is not None:
        ratio = max(sx, sy) / min(sx, sy)
        if ratio > cfg.max_step_ratio:
            smaller = min(sx, sy)
            return smaller, smaller
        avg = (sx + sy) / 2.0
        return avg, avg
    if sx is not None:
        return sx, sx
    if sy is not None:
        return sy, sy
    fallback = max(min(w, h) / cfg.fallback_target_segments, 1.0)
    return fallback, fallback


def walk(profile: np.ndarray, step_size: float, limit: int, cfg: Config) -> list[int]:
    if profile.size == 0:
        raise ValueError("Empty profile")
    cuts: list[int] = [0]
    pos = 0.0
    window = max(step_size * cfg.walker_search_window_ratio, cfg.walker_min_search_window)
    mean_val = float(profile.mean())

    while pos < limit:
        target = pos + step_size
        if target >= limit:
            cuts.append(limit)
            break
        start = max(int(target - window), int(pos + 1.0))
        end = min(int(target + window), limit)
        if end <= start:
            pos = target
            continue
        segment = profile[start:end]
        local_max = float(segment.max())
        local_idx = int(start + np.argmax(segment))
        if local_max > mean_val * cfg.walker_strength_threshold:
            cuts.append(local_idx)
            pos = float(local_idx)
        else:
            cuts.append(int(target))
            pos = target
    return cuts


def sanitize_cuts(cuts: list[int], limit: int) -> list[int]:
    seen = sorted(set(c for c in cuts if 0 <= c <= limit))
    if not seen or seen[0] != 0:
        seen = [0] + seen
    if seen[-1] != limit:
        seen.append(limit)
    deduped: list[int] = []
    for c in seen:
        if not deduped or c > deduped[-1]:
            deduped.append(c)
    return deduped


def resample(rgba: np.ndarray, col_cuts: list[int], row_cuts: list[int]) -> np.ndarray:
    out_w = len(col_cuts) - 1
    out_h = len(row_cuts) - 1
    out = np.zeros((out_h, out_w, 4), dtype=np.uint8)
    for j in range(out_h):
        y0, y1 = row_cuts[j], row_cuts[j + 1]
        for i in range(out_w):
            x0, x1 = col_cuts[i], col_cuts[i + 1]
            cell = rgba[y0:y1, x0:x1].reshape(-1, 4)
            if cell.size == 0:
                continue
            opaque = cell[cell[:, 3] > 0]
            if len(opaque) == 0:
                out[j, i] = (0, 0, 0, 0)
                continue
            tuples = [tuple(p) for p in opaque]
            most_common, _ = Counter(tuples).most_common(1)[0]
            out[j, i] = most_common
    return out


def snap_image(input_path: Path, output_path: Path, cfg: Config) -> tuple[int, int]:
    img = Image.open(input_path).convert("RGBA")
    rgba = np.array(img)
    h, w, _ = rgba.shape

    quantized = quantize(rgba, cfg)
    col_proj, row_proj = compute_profiles(quantized)
    sx = estimate_step_size(col_proj, cfg)
    sy = estimate_step_size(row_proj, cfg)
    step_x, step_y = resolve_step_sizes(sx, sy, w, h, cfg)

    col_cuts = sanitize_cuts(walk(col_proj, step_x, w, cfg), w)
    row_cuts = sanitize_cuts(walk(row_proj, step_y, h, cfg), h)

    out = resample(quantized, col_cuts, row_cuts)
    Image.fromarray(out, mode="RGBA").save(output_path)
    return out.shape[1], out.shape[0]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--k-colors", type=int, default=16)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cfg = Config(k_colors=args.k_colors, k_seed=args.seed)
    out_w, out_h = snap_image(args.input, args.output, cfg)
    print(f"Snapped {args.input} -> {args.output} ({out_w}x{out_h})")


if __name__ == "__main__":
    main()

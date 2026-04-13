#!/usr/bin/env python3
"""
Minimal image diff utility for visual-regression workflows.

Usage:
  python scripts/imgdiff.py baseline.png current.png --out diff.png
Exit codes:
  0 = identical
  1 = different
  2 = error (missing deps, unreadable images, etc.)
"""

from __future__ import annotations

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline")
    parser.add_argument("current")
    parser.add_argument("--out", default="diff.png")
    parser.add_argument("--max-rms", type=float, default=0.0)
    args = parser.parse_args()

    try:
        from PIL import Image, ImageChops  # type: ignore
        from PIL.ImageStat import Stat  # type: ignore
    except Exception:
        print("Pillow is required. Install with: pip install pillow", file=sys.stderr)
        return 2

    try:
        baseline = Image.open(args.baseline).convert("RGBA")
        current = Image.open(args.current).convert("RGBA")
    except Exception as exc:
        print(f"Failed to read images: {exc}", file=sys.stderr)
        return 2

    if baseline.size != current.size:
        print(f"Different sizes: {baseline.size} vs {current.size}", file=sys.stderr)
        return 1

    diff = ImageChops.difference(baseline, current)
    stat = Stat(diff)
    # RMS per channel, then overall RMS
    rms_channels = stat.rms
    rms = (sum(v * v for v in rms_channels) / len(rms_channels)) ** 0.5

    if rms > 0:
        diff.save(args.out)

    if rms <= args.max_rms:
        return 0

    print(f"Images differ (RMS={rms:.4f}, threshold={args.max_rms:.4f}). Wrote {args.out}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

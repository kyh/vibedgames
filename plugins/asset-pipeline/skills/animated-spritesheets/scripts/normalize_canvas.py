#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""Preserve-motion normalization for **video-derived** frames.

Why this exists separately from normalize_frames.py:
- normalize_frames.py recenters EACH frame on its own alpha bbox (center-x /
  bottom-y). That is right for posed image sheets, but wrong for a walk/run clip:
  re-centering every frame cancels the very translation that makes it read as
  motion, so the sprite "skates" in place.
- Image-to-video frames already share ONE camera canvas. So we compute a single
  shared crop + scale + ground anchor from the UNION of all frames and apply the
  SAME transform to every frame. Relative motion is preserved; scale and the
  ground line stay consistent across the loop.

Usage:
  normalize_canvas.py --input-dir keyed/ --out-dir runtime/ --canvas 256x256
  normalize_canvas.py --selftest
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

from PIL import Image


def _parse_size(text: str) -> tuple[int, int]:
    w, h = text.lower().split("x")
    return int(w), int(h)


def normalize_canvas(
    input_dir: Path,
    out_dir: Path,
    *,
    glob: str = "frame-*.png",
    canvas: tuple[int, int] = (256, 256),
    pad: int = 6,
    allow_upscale: bool = True,
    target_height: int | None = None,
    char_fill: float = 0.5,
) -> list[Path]:
    paths = sorted(input_dir.glob(glob))
    if not paths:
        raise SystemExit(f"no frames matching {glob} in {input_dir}")
    images = [Image.open(p).convert("RGBA") for p in paths]
    boxes = [im.getchannel("A").getbbox() for im in images]
    boxes = [b for b in boxes if b is not None]
    if not boxes:
        raise SystemExit(f"all frames in {input_dir} are empty")
    # shared union bbox across the whole clip (preserves relative motion)
    ul = min(b[0] for b in boxes)
    ut = min(b[1] for b in boxes)
    ur = max(b[2] for b in boxes)
    ub = max(b[3] for b in boxes)
    uw, uh = ur - ul, ub - ut

    cw, ch = canvas
    avail_w, avail_h = cw - 2 * pad, ch - 2 * pad
    # The CHARACTER (median per-frame visible height, robust to the vertical travel
    # baked into the union) is what we keep consistent across actions.
    hs = sorted(b[3] - b[1] for b in boxes)
    n = len(hs)
    char_h = (hs[n // 2] if n % 2 else (hs[n // 2 - 1] + hs[n // 2]) / 2) or 1
    # Aim the character at a FRACTION of the cell (default ~50%) so there is headroom
    # for attack arcs and jump travel — hand-authored sheets keep the character small
    # with margin so a big slash never clips. A size contract overrides the fraction
    # with a shared target so every action of one character is the same size.
    char_target = target_height if target_height else ch * char_fill
    scale_char = char_target / char_h
    # Never let the full clip union overflow the cell -> nothing gets cut off.
    scale_fit = min(avail_w / uw, avail_h / uh)
    scale = min(scale_char, scale_fit)
    if not allow_upscale:
        scale = min(scale, 1.0)

    new_w, new_h = max(1, round(uw * scale)), max(1, round(uh * scale))
    paste_x = (cw - new_w) // 2          # horizontally centred on the union
    paste_y = (ch - pad) - new_h         # union bottom sits on the ground line

    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for src, im in zip(paths, images):
        # crop EVERY frame to the SAME union box, then apply the SAME transform
        cropped = im.crop((ul, ut, ur, ub)).resize((new_w, new_h), Image.LANCZOS)
        frame = Image.new("RGBA", canvas, (0, 0, 0, 0))
        frame.paste(cropped, (paste_x, paste_y), cropped)
        dst = out_dir / src.name
        frame.save(dst)
        written.append(dst)
    return written


def selftest() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="normalize_canvas_selftest_"))
    src = tmp / "in"
    src.mkdir()
    # square that translates left->right across frames (motion to preserve)
    for i in range(4):
        im = Image.new("RGBA", (120, 120), (0, 0, 0, 0))
        x = 20 + i * 20
        for yy in range(70, 100):
            for xx in range(x, x + 20):
                im.putpixel((xx, yy), (200, 40, 40, 255))
        im.save(src / f"frame-{i + 1:02d}.png")
    out = tmp / "out"
    written = normalize_canvas(src, out, canvas=(256, 256), pad=6)
    assert len(written) == 4
    centers = []
    for p in written:
        im = Image.open(p).convert("RGBA")
        assert im.size == (256, 256), "output must be runtime canvas size"
        bb = im.getchannel("A").getbbox()
        assert bb is not None
        centers.append((bb[0] + bb[2]) / 2)
        # ground anchor: union bottom near canvas bottom for every frame
        assert bb[3] >= 256 - 6 - 2, f"bottom not anchored: {bb}"
    # motion preserved: the square's x-center must MOVE across frames
    assert max(centers) - min(centers) > 20, f"motion was cancelled (skating): {centers}"
    # ... and strictly increase, like the source translation
    assert centers == sorted(centers), f"order/motion not preserved: {centers}"
    print("normalize_canvas selftest: OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Preserve-motion normalization for video-derived frames.")
    ap.add_argument("--input-dir", type=Path)
    ap.add_argument("--out-dir", type=Path)
    ap.add_argument("--glob", default="frame-*.png")
    ap.add_argument("--canvas", default="256x256")
    ap.add_argument("--pad", type=int, default=6)
    ap.add_argument("--no-upscale", action="store_true", help="do not scale a small sprite up to fill the cell")
    ap.add_argument("--target-height", type=int, default=None,
                    help="scale so the character's median visible height = N px (shared scale across actions)")
    ap.add_argument("--char-fill", type=float, default=0.5,
                    help="character height as a fraction of the cell when no target (headroom for effects; default 0.5)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not args.input_dir or not args.out_dir:
        ap.error("--input-dir and --out-dir are required (or use --selftest)")
    written = normalize_canvas(
        args.input_dir, args.out_dir, glob=args.glob,
        canvas=_parse_size(args.canvas), pad=args.pad, allow_upscale=not args.no_upscale,
        target_height=args.target_height, char_fill=args.char_fill,
    )
    print(args.out_dir)
    print(f"{len(written)} frames")
    return 0


if __name__ == "__main__":
    sys.exit(main())

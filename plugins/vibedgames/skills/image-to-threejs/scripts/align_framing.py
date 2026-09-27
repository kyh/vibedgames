#!/usr/bin/env -S uv run --python 3.12 --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Framing alignment and crop-zoom for the review gates.

Tier-1 (`diagnose_render.py`) compares frame-aligned silhouette masks, but the
shared camera (`render_model.py`) leaves a fixed margin while references
usually fill their frame — so a correct model false-fails on framing alone.
This tool measures the subject bbox of BOTH images (plain-background product
shots), then crops the render so the subject fills its frame the way the
reference fills its own. The camera is untouched: this is evidence alignment,
not a re-render. Crop math is recorded in a JSON sidecar so the next agent can
audit it.

    uv run align_framing.py align --reference ref/door.jpg \
        --render runs/structural/front.png --out runs/structural/front-aligned.png

Also the crop-zoom tool the authoring step needs (recessed heads, part
adjacency — detail the full frame hides):

    uv run align_framing.py crop --image ref/barrel.jpg \
        --box 0.25,0.02,0.75,0.30 --zoom 3 --out ref-zones/top-head.png

    uv run align_framing.py --selftest
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image


I2T_DEFAULT = Path.home() / ".local/share/img2threejs"


def upstream_mask(img: Image.Image, i2t: Path):
    """Mask via upstream's own foreground masker so alignment agrees with the
    tier-1 gate by construction (it excludes ground shadow; a naive border-
    median threshold does not and over-measures fill on real JPEGs)."""
    sys.path.insert(0, str(i2t / "forge" / "stage1_intake"))
    from extract_pbr_evidence import build_foreground_mask  # noqa: PLC0415

    rgb = img.convert("RGB")
    w, h = rgb.size
    mask, _diag, _warn = build_foreground_mask(w, h, list(rgb.getdata()))
    return w, h, mask


def subject_bbox(img: Image.Image, threshold: int, i2t: Path) -> tuple[int, int, int, int]:
    """Bbox of the subject, preferring the gate's own masker."""
    try:
        w, h, mask = upstream_mask(img, i2t)
        xs = [i % w for i, v in enumerate(mask) if v]
        ys = [i // w for i, v in enumerate(mask) if v]
        if xs:
            return min(xs), min(ys), max(xs), max(ys)
    except Exception as err:  # noqa: BLE001 — fall back to the naive mask
        print(f"  (upstream masker unavailable: {err}; using border-median fallback)", file=sys.stderr)

    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    border = []
    for x in range(0, w, max(1, w // 64)):
        border.append(px[x, 0])
        border.append(px[x, h - 1])
    for y in range(0, h, max(1, h // 64)):
        border.append(px[0, y])
        border.append(px[w - 1, y])
    border.sort()
    bg = border[len(border) // 2]

    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > threshold:
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                if y < y0:
                    y0 = y
                if y > y1:
                    y1 = y
    if x1 < 0:
        raise SystemExit("no foreground found — is the background non-uniform?")
    return x0, y0, x1, y1


def parse_bbox(spec: str, size: tuple[int, int]) -> tuple[int, int, int, int]:
    v = [float(x) for x in spec.split(",")]
    if all(0 <= x <= 1 for x in v):
        v = [v[0] * size[0], v[1] * size[1], v[2] * size[0], v[3] * size[1]]
    return round(v[0]), round(v[1]), round(v[2]), round(v[3])


def sane(bbox: tuple[int, int, int, int], size: tuple[int, int]) -> bool:
    # A subject bbox spanning ~the whole frame means the mask ate the
    # background (soft JPEG gradients defeat both maskers).
    w, h = size
    return (bbox[2] - bbox[0]) < 0.98 * w or (bbox[3] - bbox[1]) < 0.98 * h


def cmd_align(args: argparse.Namespace) -> int:
    ref = Image.open(args.reference)
    ren = Image.open(args.render)

    if args.ref_bbox:
        rx0, ry0, rx1, ry1 = parse_bbox(args.ref_bbox, ref.size)
    else:
        rx0, ry0, rx1, ry1 = subject_bbox(ref, args.bg_threshold, args.i2t)
        if not sane((rx0, ry0, rx1, ry1), ref.size):
            raise SystemExit(
                "reference mask spans the whole frame — the background gradient defeated "
                "both maskers. Eyeball the subject bounds (crop-zoom helps) and pass "
                "--ref-bbox x0,y0,x1,y1 (px or 0-1 fractions); it is recorded in the sidecar."
            )
    if args.render_bbox:
        nx0, ny0, nx1, ny1 = parse_bbox(args.render_bbox, ren.size)
    else:
        nx0, ny0, nx1, ny1 = subject_bbox(ren, args.bg_threshold, args.i2t)

    ref_w, ref_h = ref.size
    # How the reference's subject sits in its own frame.
    fill = (ry1 - ry0 + 1) / ref_h
    cx_frac = ((rx0 + rx1) / 2) / ref_w
    cy_frac = ((ry0 + ry1) / 2) / ref_h

    # Cut a square-ish window around the render's subject reproducing that fill
    # and centring, clamped to the canvas.
    subj_h = ny1 - ny0 + 1
    side = subj_h / fill
    cx = (nx0 + nx1) / 2
    cy = (ny0 + ny1) / 2
    left = max(0, round(cx - cx_frac * side))
    top = max(0, round(cy - cy_frac * side))
    right = min(ren.size[0], round(left + side))
    bottom = min(ren.size[1], round(top + side))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    ren.crop((left, top, right, bottom)).resize(ref.size).save(out)

    sidecar = {
        "reference": str(args.reference),
        "refBboxSource": "override" if args.ref_bbox else "measured",
        "render": str(args.render),
        "referenceSubjectBbox": [rx0, ry0, rx1, ry1],
        "renderSubjectBbox": [nx0, ny0, nx1, ny1],
        "referenceHeightFill": round(fill, 4),
        "cropBox": [left, top, right, bottom],
        "resizedTo": list(ref.size),
    }
    Path(str(out) + ".json").write_text(json.dumps(sidecar, indent=2) + "\n")
    print(f"aligned -> {out} (fill {fill:.3f}, crop {left},{top}..{right},{bottom}); math in {out}.json")
    return 0


def cmd_crop(args: argparse.Namespace) -> int:
    img = Image.open(args.image)
    w, h = img.size
    fx0, fy0, fx1, fy1 = (float(v) for v in args.box.split(","))
    box = (round(fx0 * w), round(fy0 * h), round(fx1 * w), round(fy1 * h))
    crop = img.crop(box)
    if args.zoom > 1:
        crop = crop.resize((crop.width * args.zoom, crop.height * args.zoom), Image.NEAREST)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    crop.save(out)
    print(f"crop {box} zoom x{args.zoom} -> {out}")
    return 0


def selftest() -> int:
    from PIL import ImageDraw

    ref = Image.new("RGB", (200, 200), (230, 230, 230))
    ImageDraw.Draw(ref).rectangle([40, 20, 160, 180], fill=(120, 80, 40))  # fill 0.805
    ren = Image.new("RGB", (200, 200), (184, 184, 184))
    ImageDraw.Draw(ren).rectangle([70, 60, 130, 140], fill=(120, 80, 40))  # small, margined

    import tempfile

    with tempfile.TemporaryDirectory() as td:
        rp, np_, op = Path(td, "ref.png"), Path(td, "ren.png"), Path(td, "out.png")
        ref.save(rp)
        ren.save(np_)
        ns = argparse.Namespace(
            reference=rp, render=np_, out=op, bg_threshold=30,
            i2t=Path("/nonexistent"), ref_bbox=None, render_bbox=None,
        )
        cmd_align(ns)
        sidecar = json.loads(Path(str(op) + ".json").read_text())
        assert sidecar["referenceHeightFill"] > 0.79, sidecar
        aligned = Image.open(op)
        bx0, by0, bx1, by1 = subject_bbox(aligned, 30, Path("/nonexistent"))
        new_fill = (by1 - by0 + 1) / aligned.size[1]
        assert abs(new_fill - sidecar["referenceHeightFill"]) < 0.06, (new_fill, sidecar)
    print("selftest ok")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selftest", action="store_true")
    sub = ap.add_subparsers(dest="cmd")

    al = sub.add_parser("align", help="crop a render to the reference's framing")
    al.add_argument("--reference", required=True, type=Path)
    al.add_argument("--render", required=True, type=Path)
    al.add_argument("--out", required=True, type=Path)
    al.add_argument("--bg-threshold", type=int, default=30)
    al.add_argument("--i2t", type=Path, default=I2T_DEFAULT, help="upstream clone (for its foreground masker)")
    al.add_argument("--ref-bbox", help="override reference subject bbox: x0,y0,x1,y1 (px or 0-1 fractions)")
    al.add_argument("--render-bbox", help="override render subject bbox (same format)")

    cr = sub.add_parser("crop", help="crop-zoom a region (fractions of width/height)")
    cr.add_argument("--image", required=True, type=Path)
    cr.add_argument("--box", required=True, help="x0,y0,x1,y1 as 0-1 fractions")
    cr.add_argument("--zoom", type=int, default=2)
    cr.add_argument("--out", required=True, type=Path)

    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if args.cmd == "align":
        return cmd_align(args)
    if args.cmd == "crop":
        return cmd_crop(args)
    ap.error("pass a subcommand or --selftest")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

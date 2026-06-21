#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""One command: turn a generated **image pose board / strip** into runtime frames.

The image generation path (vs process_video.py). You generate ONE image whose
cells are the animation frames — a uniform R x C grid (or a 1-row strip) of the
same character in different poses — then this slices it on that grid, cleans the
matte, normalizes per-frame to a shared anchor, and packs the spritesheet.

By default this assumes a UNIFORM grid (which is how hand-authored sheets are
laid out and what you should prompt the model for) and slices it directly — far
more predictable than trying to recover drifted blobs. Pass --recover to instead
run connected-component recovery (Spriterrific-style), which tolerates the model
spilling a pose across cell borders; pass --pixel-snap for the crisp low-bit look.

Pipeline: (slice grid | --recover components) -> chroma_clean (per cell) ->
normalize_frames (per-frame anchor) -> [--pixel-snap per frame] -> pack -> gif.

Example:
  process_sheet.py board.png --action attack --rows 2 --cols 2 --out-dir runs/hero-attack-img
  process_sheet.py board.png --action attack --rows 2 --cols 2 --recover --pixel-snap --out-dir runs/...
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent


def _uv() -> str:
    found = shutil.which("uv")
    if not found:
        raise SystemExit("uv not found on PATH. Install: curl -LsSf https://astral.sh/uv/install.sh | sh")
    return found


def run_step(label: str, script: str, *a: str) -> str:
    p = subprocess.run([_uv(), "run", str(HERE / script), *a], capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(f"\n[process_sheet] step '{label}' failed:\n{p.stderr}\n")
        raise SystemExit(p.returncode)
    return p.stdout.strip()


def action_facts(action: str) -> dict:
    return json.loads(run_step("presets", "sprite_presets.py", "--action", action, "--json"))


def slice_grid(board: Path, rows: int, cols: int, frames: int, out_dir: Path) -> int:
    img = Image.open(board).convert("RGBA")
    cw, ch = img.width // cols, img.height // rows
    out_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for i in range(min(frames, rows * cols)):
        r, c = divmod(i, cols)
        cell = img.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
        cell.save(out_dir / f"frame-{i + 1:02d}.png")
        n += 1
    return n


def recover_grid(board: Path, rows: int, cols: int, frames: int, out_dir: Path) -> int:
    """Connected-component recovery (Spriterrific-style): tolerates poses spilling
    across cell borders. Emits frame-NN.png; returns the frame count."""
    run_step("recover", "recover_component_frames.py", str(board),
             "--rows", str(rows), "--cols", str(cols), "--frames", str(frames),
             "--out-dir", str(out_dir), "--prefix", "frame")
    return len(sorted(out_dir.glob("frame-[0-9]*.png")))


def pixel_snap_frames(frames_dir: Path, k_colors: int) -> None:
    """Snap each frame onto its native pixel grid, in place. Run before normalize:
    snapping shrinks frames to per-frame native sizes, so the downstream anchor
    normalization must re-uniform them for the packer."""
    for frame in sorted(frames_dir.glob("frame-*.png")):
        run_step("pixel-snap", "pixel_snapper.py", str(frame), str(frame),
                 "--k-colors", str(k_colors))


def main() -> int:
    ap = argparse.ArgumentParser(description="Image pose board/strip -> runtime sprite frames (one command).")
    ap.add_argument("board", type=Path, help="generated pose board PNG (sprites on a flat chroma matte)")
    ap.add_argument("--action", required=True)
    ap.add_argument("--rows", type=int, required=True, help="grid rows the model laid out")
    ap.add_argument("--cols", type=int, required=True, help="grid cols the model laid out")
    ap.add_argument("--frames", type=int, default=None, help="cells used (first N); default rows*cols")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--chroma", default="#00FF00")
    ap.add_argument("--char-fill", type=float, default=0.5, help="character height as a fraction of the cell (headroom)")
    ap.add_argument("--recover", action="store_true",
                    help="recover frames by connected components (handles poses spilling across cells) instead of naive grid slicing")
    ap.add_argument("--pixel-snap", action="store_true",
                    help="snap each runtime frame onto its native pixel grid after normalize (crisp low-bit look)")
    ap.add_argument("--snap-k-colors", type=int, default=16, help="palette size for --pixel-snap (k-means)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not args.board.exists():
        raise SystemExit(f"board not found: {args.board}")
    facts = action_facts(args.action)
    fps = int(facts["fps"])
    frames = args.frames if args.frames is not None else args.rows * args.cols

    out = args.out_dir
    d_cells, d_keyed, d_runtime, d_review = out/"cells", out/"_keyed", out/"runtime", out/"review"

    # 1. produce per-frame cells: naive uniform slice (default) or component recovery
    if args.recover:
        n = recover_grid(args.board, args.rows, args.cols, frames, d_cells)
    else:
        n = slice_grid(args.board, args.rows, args.cols, frames, d_cells)
    # 2. key the matte + fringe + despill + decontaminate (per cell, one batch call)
    run_step("clean", "chroma_clean.py", "clean", "--input", str(d_cells),
             "--out-dir", str(d_keyed), "--chroma", args.chroma)
    # 2b. optional: snap each keyed frame onto its native pixel grid. Done BEFORE
    # normalize so the per-frame anchor step re-uniforms the (variably-shrunk)
    # snapped frames back onto the shared canvas — the packer needs uniform sizes.
    if args.pixel_snap:
        pixel_snap_frames(d_keyed, args.snap_k_colors)
    # 3. per-frame anchor normalization with headroom (image poses are discrete)
    run_step("normalize", "normalize_canvas.py", "--input-dir", str(d_keyed), "--out-dir", str(d_runtime),
             "--glob", "frame-*.png", "--canvas", "256x256", "--char-fill", str(args.char_fill))
    # 4. pack + gif
    sheet_png, sheet_json = out/"spritesheet.png", out/"spritesheet.json"
    run_step("pack", "pack_spritesheet.py", "--input-dir", str(d_runtime), "--glob", "frame-*.png",
             "--out", str(sheet_png), "--json-out", str(sheet_json), "--action", args.action, "--fps", str(fps))
    d_review.mkdir(parents=True, exist_ok=True)
    gif = d_review / f"{args.action}.gif"
    order = ",".join(f"{i:02d}" for i in range(1, n + 1))
    run_step("gif", "build_sequence_gif.py", "--input-dir", str(d_runtime), "--pattern", "frame-{id}.png",
             "--order", order, "--out", str(gif), "--durations-ms", ",".join([str(round(1000 / fps))] * n))

    summary = {"action": args.action, "frames": n, "fps": fps, "path": "image",
               "slicing": "recover" if args.recover else "naive", "pixelSnap": bool(args.pixel_snap),
               "spritesheet": str(sheet_png), "gif": str(gif), "runtimeFrames": str(d_runtime)}
    print(json.dumps(summary, indent=2) if args.json else
          f"\n=== {args.action} (image): {n} frames @ {fps}fps ===\n  sheet: {sheet_png}\n  gif: {gif}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

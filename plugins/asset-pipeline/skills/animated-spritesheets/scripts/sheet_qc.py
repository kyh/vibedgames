#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0", "numpy>=1.26"]
# ///
"""Quality-control a packed spritesheet — the eval that tells an agent whether to
ship the sheet or regenerate the board.

The pose-board model has two recurring failure modes the deterministic pipeline
cannot fix on its own:
  - SIZE DRIFT: the character is drawn at different scales across cells, so the
    sliced frames look like the character grows/shrinks mid-animation.
  - FACING FLIP: one cell (often frame 1) is mirrored, so the character faces the
    wrong way for part of the animation.
plus the always-checkable: empty cells, frames that clip the cell edge, and a
foot-baseline that wanders. This script measures all of them from the alpha
channel and emits a machine-readable verdict.

HARD checks (unambiguous defects -> "warn", and fail under --strict):
  empty       a frame is blank / near-blank
  clip        a frame's opaque pixels touch the cell border (cut off)
  baseline    the foot baseline jumps between frames (normalize should pin it)

SOFT hints (need an eyeball — the script can't know intent -> "review"):
  size        a frame's height is a strong outlier vs the median. A legit pose
              change (a death collapse, a crouch) also does this, so this is a
              prompt to verify, not a proven defect. Reported as the candidate
              frames + the height coefficient of variation.
  facing      a frame's horizontal mass is a strong outlier vs the others — the
              fingerprint of a mirrored/flipped cell. Heuristic; eyeball the gif.

Usage:
  sheet_qc.py runs/hero-attack/spritesheet.png            # reads sibling .json
  sheet_qc.py sheet.png --frame-width 256 --frame-height 256 --json
  sheet_qc.py sheet.png --strict        # exit 1 if any HARD check fails
  sheet_qc.py sheet.png --fail-on-hints # exit 1 if any soft hint fires too
  sheet_qc.py --selftest
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ALPHA_ON = 16  # alpha above this counts as opaque

# thresholds (fractions of the cell unless noted)
EMPTY_AREA_FRAC = 0.003
CLIP_BORDER_FRAC = 0.01
BASELINE_TOL = 0.12
SIZE_DRIFT_TOL = 0.35
FACING_CX_TOL = 0.18


def frame_geometry(sheet: Image.Image, sheet_path: Path, fw: int | None, fh: int | None) -> tuple[int, int, int, int, int]:
    """Resolve (frame_width, frame_height, frame_count, columns, rows). Prefer an
    explicit override, then a sibling spritesheet.json manifest (which carries the
    real columns/rows for multi-row sheets), else assume a single row of squares."""
    if fw is not None and fh is not None:
        if fw <= 0 or fh <= 0:
            raise SystemExit("--frame-width and --frame-height must be positive")
        cols = max(1, sheet.width // fw)
        return fw, fh, cols, cols, 1
    manifest = sheet_path.with_suffix(".json")
    if manifest.exists():
        m = json.loads(manifest.read_text())
        count = int(m["frameCount"])
        cols = int(m.get("columns") or count)
        rows = int(m.get("rows") or 1)
        return int(m["frameWidth"]), int(m["frameHeight"]), count, cols, rows
    side = sheet.height
    return side, side, max(1, sheet.width // side), max(1, sheet.width // side), 1


def split_frame_alphas(arr: np.ndarray, fw: int, fh: int, count: int, cols: int) -> list[np.ndarray]:
    """Slice the packed sheet's alpha channel into per-frame views, row-major —
    respects a multi-row grid (cols/rows from the manifest), not just a single strip."""
    out = []
    for i in range(count):
        r, c = divmod(i, cols)
        out.append(arr[r * fh:(r + 1) * fh, c * fw:(c + 1) * fw, 3])
    return out


def frame_metrics(alpha: np.ndarray, fw: int, fh: int) -> dict[str, object]:
    ys, xs = np.where(alpha > ALPHA_ON)
    if len(ys) == 0:
        return {"empty": True, "area_frac": 0.0, "height": 0, "width": 0,
                "cx_frac": 0.0, "baseline_frac": 1.0, "border_frac": 0.0}
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    edge = np.concatenate([alpha[0, :], alpha[-1, :], alpha[:, 0], alpha[:, -1]])
    return {
        "empty": False,
        "area_frac": round(float((alpha > ALPHA_ON).mean()), 4),
        "height": y1 - y0 + 1,
        "width": x1 - x0 + 1,
        # horizontal mass offset from cell centre, as a fraction of width (+ = right)
        "cx_frac": round(float(xs.mean() - fw / 2) / fw, 4),
        # foot baseline = bottom of the figure, as a fraction from the top
        "baseline_frac": round((y1 + 1) / fh, 4),
        "border_frac": round(float((edge > ALPHA_ON).mean()), 4),
    }


def _local_extremum(vals: list[float], i: int) -> bool:
    """True if vals[i] is a spike/dip vs both neighbours (so it is NOT part of a
    monotonic trend like a death-collapse — that distinguishes scale drift from
    a legitimate pose arc)."""
    if i == 0 or i == len(vals) - 1:
        return False
    return (vals[i] > vals[i - 1] and vals[i] > vals[i + 1]) or (vals[i] < vals[i - 1] and vals[i] < vals[i + 1])


def qc(metrics: list[dict[str, object]]) -> list[dict[str, object]]:
    checks: list[dict[str, object]] = []
    live = [(i, m) for i, m in enumerate(metrics) if not m["empty"]]

    empty = [i + 1 for i, m in enumerate(metrics) if m["empty"] or float(m["area_frac"]) < EMPTY_AREA_FRAC]
    if empty:
        checks.append({"check": "empty", "severity": "warn", "frames": empty,
                       "detail": f"{len(empty)} frame(s) blank or near-blank (area < {EMPTY_AREA_FRAC:.1%})"})

    clipped = [i + 1 for i, m in enumerate(metrics) if float(m["border_frac"]) > CLIP_BORDER_FRAC]
    if clipped:
        checks.append({"check": "clip", "severity": "warn", "frames": clipped,
                       "detail": f"{len(clipped)} frame(s) touch the cell border (likely cut off)"})

    if len(live) >= 2:
        baselines = [float(m["baseline_frac"]) for _, m in live]
        spread = max(baselines) - min(baselines)
        if spread > BASELINE_TOL:
            worst = [live[k][0] + 1 for k, b in enumerate(baselines)
                     if abs(b - statistics.median(baselines)) > BASELINE_TOL / 2]
            checks.append({"check": "baseline", "severity": "warn", "frames": worst,
                           "detail": f"foot baseline varies {spread:.0%} of cell height (should be pinned by normalize)"})

        heights = [float(m["height"]) for _, m in live]
        med = statistics.median(heights)
        cov = round(statistics.pstdev(heights) / med, 3) if med else 0.0
        drift = [h / med for h in heights]
        # flag only NON-monotonic outliers (a spike/dip), so a legit collapse/crouch arc is spared
        size_frames = [live[k][0] + 1 for k, d in enumerate(drift)
                       if abs(d - 1.0) > SIZE_DRIFT_TOL and _local_extremum(drift, k)]
        if size_frames:
            checks.append({"check": "size", "severity": "hint", "frames": size_frames, "height_cov": cov,
                           "detail": f"frame(s) are isolated size outliers (>{SIZE_DRIFT_TOL:.0%} off median height) "
                                     f"— verify it is an intended pose change, not the model drawing the character "
                                     f"at a different scale. height CoV={cov}"})

        cxs = [float(m["cx_frac"]) for _, m in live]
        med_cx = statistics.median(cxs)
        facing_frames = [live[k][0] + 1 for k, c in enumerate(cxs) if abs(c - med_cx) > FACING_CX_TOL]
        if facing_frames:
            checks.append({"check": "facing", "severity": "hint", "frames": facing_frames,
                           "detail": f"frame(s) have horizontal mass far from the others (median cx={med_cx:+.2f}) "
                                     f"— possible mirrored/flipped facing; eyeball the review gif"})
    return checks


def verdict_for(checks: list[dict[str, object]]) -> str:
    if any(c["severity"] == "warn" for c in checks):
        return "warn"
    if any(c["severity"] == "hint" for c in checks):
        return "review"
    return "clean"


def run(sheet_path: Path, fw: int | None, fh: int | None) -> dict[str, object]:
    sheet = Image.open(sheet_path).convert("RGBA")
    frame_w, frame_h, count, cols, rows = frame_geometry(sheet, sheet_path, fw, fh)
    arr = np.asarray(sheet)
    metrics = [frame_metrics(a, frame_w, frame_h) for a in split_frame_alphas(arr, frame_w, frame_h, count, cols)]
    checks = qc(metrics)
    return {
        "sheet": str(sheet_path),
        "frameWidth": frame_w, "frameHeight": frame_h, "frameCount": count,
        "columns": cols, "rows": rows,
        "verdict": verdict_for(checks),
        "checks": checks,
        "frames": metrics,
    }


def _print_human(report: dict[str, object]) -> None:
    v = report["verdict"]
    mark = {"clean": "OK", "review": "REVIEW", "warn": "WARN"}[str(v)]
    print(f"[{mark}] {report['sheet']}  ({report['frameCount']} frames {report['frameWidth']}x{report['frameHeight']})")
    for c in report["checks"]:  # type: ignore[union-attr]
        sev = "!" if c["severity"] == "warn" else "?"
        print(f"  {sev} {c['check']}: frames {c['frames']} — {c['detail']}")
    if not report["checks"]:
        print("  no issues: sizes consistent, facing consistent, no clipping or empty cells.")


def _make_frame(h: int, baseline: int, cx_shift: int = 0, touch_edge: bool = False, blank: bool = False, size: int = 64) -> Image.Image:
    """Synthetic cell: a centred vertical bar `h` tall with its feet at `baseline`."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if blank:
        return im
    px = im.load()
    cx = size // 2 + cx_shift
    x0 = 0 if touch_edge else cx - 6
    for y in range(baseline - h, baseline):
        for x in range(max(0, x0), min(size, cx + 6)):
            px[x, y] = (200, 120, 80, 255)
    return im


def _pack(frames: list[Image.Image]) -> Image.Image:
    s = frames[0].width
    out = Image.new("RGBA", (s * len(frames), s), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        out.alpha_composite(f, (i * s, 0))
    return out


def selftest() -> int:
    s = 64
    def report_for(frames: list[Image.Image]) -> dict[str, object]:
        arr = np.asarray(_pack(frames))
        metrics = [frame_metrics(arr[:, i * s:(i + 1) * s, 3], s, s) for i in range(len(frames))]
        return {"checks": qc(metrics), "verdict": verdict_for(qc(metrics))}

    # clean: 4 identical centred bars, feet pinned, none touching the edge.
    clean = [_make_frame(40, 56) for _ in range(4)]
    r = report_for(clean)
    assert r["verdict"] == "clean", f"uniform frames must be clean, got {r}"

    # empty cell.
    r = report_for([_make_frame(40, 56), _make_frame(40, 56, blank=True), _make_frame(40, 56)])
    assert any(c["check"] == "empty" for c in r["checks"]), "blank cell must flag empty"

    # edge clip.
    r = report_for([_make_frame(40, 56), _make_frame(40, 56, touch_edge=True), _make_frame(40, 56)])
    assert any(c["check"] == "clip" for c in r["checks"]), "edge-touching cell must flag clip"

    # isolated size spike (frame 2 much taller than its neighbours) -> size hint.
    r = report_for([_make_frame(40, 56), _make_frame(62, 56), _make_frame(40, 56), _make_frame(40, 56)])
    assert any(c["check"] == "size" for c in r["checks"]), "isolated tall frame must flag size"

    # MONOTONIC shrink (a collapse) must NOT flag size — distinguishes drift from a pose arc.
    r = report_for([_make_frame(56, 56), _make_frame(48, 56), _make_frame(36, 56), _make_frame(22, 56)])
    assert not any(c["check"] == "size" for c in r["checks"]), "monotonic collapse must not flag size drift"

    # facing flip: one frame's mass shoved far to one side.
    r = report_for([_make_frame(40, 56), _make_frame(40, 56), _make_frame(40, 56, cx_shift=18)])
    assert any(c["check"] == "facing" for c in r["checks"]), "off-side frame must flag facing"

    # row-major split honours a multi-row grid: pack 4 frames as 2x2, mark only
    # the bottom-right cell, and confirm it lands at index 3 (not a single-row read).
    grid = Image.new("RGBA", (s * 2, s * 2), (0, 0, 0, 0))
    grid.alpha_composite(_make_frame(40, 56), (s, s))  # col 1, row 1 -> frame index 3
    alphas = split_frame_alphas(np.asarray(grid), s, s, 4, 2)
    nonempty = [i for i, a in enumerate(alphas) if (a > ALPHA_ON).any()]
    assert nonempty == [3], f"2x2 row-major split must place the bottom-right cell at index 3, got {nonempty}"

    print("sheet_qc selftest: OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Quality-control a packed spritesheet (size/facing/clip/empty/baseline).")
    ap.add_argument("sheet", nargs="?", type=Path, help="path to spritesheet.png")
    ap.add_argument("--frame-width", type=int, default=None)
    ap.add_argument("--frame-height", type=int, default=None)
    ap.add_argument("--json", action="store_true", help="emit the full report as JSON")
    ap.add_argument("--strict", action="store_true", help="exit 1 if any HARD check (empty/clip/baseline) fails")
    ap.add_argument("--fail-on-hints", action="store_true", help="also exit 1 on soft hints (size/facing)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not args.sheet:
        ap.error("a spritesheet path is required (or use --selftest)")
    report = run(args.sheet, args.frame_width, args.frame_height)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_human(report)
    if args.fail_on_hints and report["verdict"] != "clean":
        return 1
    if args.strict and report["verdict"] == "warn":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

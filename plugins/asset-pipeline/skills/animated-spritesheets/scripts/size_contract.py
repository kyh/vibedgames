#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path
from typing import Any

from PIL import Image


# Runtime cell size.
FRAME_WIDTH = 256
FRAME_HEIGHT = 256


DEFAULT_TOLERANCES: dict[str, float | int | None] = {
    "maxTargetHeightDriftPct": 0.08,
    "maxIntraHeightDriftPct": 0.08,
    "maxBottomDriftPx": 2,
    "maxWidthOverflowPct": 0.12,
    "maxCenterDriftPx": None,
}


def write_json(path: Path, obj: Any) -> None:
    """Write JSON to path (mkdir -p parent, dump with indent=2)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def load_size_contract(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"size contract must be a JSON object: {path}")
    if data.get("kind") != "sprite-size-contract":
        raise ValueError(f"not a sprite size contract: {path}")
    contract = dict(data)
    contract.setdefault("runtimeCell", [FRAME_WIDTH, FRAME_HEIGHT])
    contract.setdefault("anchorPolicy", "grounded")
    contract.setdefault("pivot", "base-center")
    contract.setdefault("tolerances", {})
    contract["tolerances"] = {**DEFAULT_TOLERANCES, **dict(contract["tolerances"])}
    return contract


def derive_size_contract(
    source: Path,
    *,
    out: Path,
    cell_size: tuple[int, int] = (FRAME_WIDTH, FRAME_HEIGHT),
    frame_glob: str = "frame-*.png",
    name: str | None = None,
    action: str | None = None,
    direction: str | None = None,
    anchor_policy: str = "grounded",
    pivot: str = "base-center",
    source_canvas: tuple[int, int] | None = None,
    tolerances: dict[str, float | int | None] | None = None,
) -> Path:
    measurements = measure_source(source, cell_size=cell_size, frame_glob=frame_glob)
    summary = summarize_measurements(measurements)
    if summary["nonEmptyFrames"] == 0:
        raise ValueError(f"cannot derive size contract from empty source: {source}")

    merged_tolerances = {**DEFAULT_TOLERANCES, **(tolerances or {})}
    contract = {
        "version": 1,
        "kind": "sprite-size-contract",
        "name": name or source.stem,
        "source": str(source),
        "sourceKind": "directory" if source.is_dir() else "image",
        "action": action,
        "direction": direction,
        "runtimeCell": [cell_size[0], cell_size[1]],
        "sourceCanvas": list(source_canvas) if source_canvas else summary.get("frameSize"),
        "anchorPolicy": anchor_policy,
        "pivot": pivot,
        "targetVisibleHeight": round(float(summary["medianVisibleHeight"])),
        "targetVisibleWidth": round(float(summary["medianVisibleWidth"])),
        "maxVisibleWidth": int(summary["maxVisibleWidth"]),
        "targetBottomY": round(float(summary["medianBottomY"])),
        "targetCenterX": round(float(summary["medianCenterX"])),
        "tolerances": merged_tolerances,
        "measurementsSummary": summary,
        "measurements": measurements,
        "promptGuidance": prompt_guidance_for_contract(
            {
                "runtimeCell": [cell_size[0], cell_size[1]],
                "targetVisibleHeight": round(float(summary["medianVisibleHeight"])),
                "targetBottomY": round(float(summary["medianBottomY"])),
                "pivot": pivot,
            }
        ),
    }
    write_json(out, contract)
    return out


def audit_size_contract(
    source: Path,
    contract: dict[str, Any],
    *,
    out: Path | None = None,
    cell_size: tuple[int, int] | None = None,
    frame_glob: str = "frame-*.png",
    stage: str = "runtime",
) -> dict[str, Any]:
    resolved_cell_size = cell_size or _cell_size(contract)
    measurements = measure_source(source, cell_size=resolved_cell_size, frame_glob=frame_glob)
    summary = summarize_measurements(measurements)
    checks = _contract_checks(summary, contract)
    passed = all(check["status"] == "pass" for check in checks)
    report = {
        "version": 1,
        "kind": "sprite-size-contract-audit",
        "stage": stage,
        "source": str(source),
        "contract": _contract_brief(contract),
        "status": "pass" if passed else "warn",
        "passed": passed,
        "summary": summary,
        "checks": checks,
        "measurements": measurements,
    }
    if out is not None:
        write_json(out, report)
    return report


def measure_source(source: Path, *, cell_size: tuple[int, int], frame_glob: str = "frame-*.png") -> list[dict[str, Any]]:
    if source.is_dir():
        return [_measure_image(path, label=path.name) for path in sorted(source.glob(frame_glob))]
    if not source.exists():
        raise ValueError(f"missing size contract source: {source}")
    return _measure_image_or_sheet(source, cell_size=cell_size)


def summarize_measurements(measurements: list[dict[str, Any]]) -> dict[str, Any]:
    non_empty = [item for item in measurements if not item.get("empty")]
    if not non_empty:
        return {
            "frames": len(measurements),
            "nonEmptyFrames": 0,
            "frameSize": None,
        }
    widths = [int(item["visibleWidth"]) for item in non_empty]
    heights = [int(item["visibleHeight"]) for item in non_empty]
    bottoms = [int(item["visibleBottomY"]) for item in non_empty]
    centers = [float(item["visibleCenterX"]) for item in non_empty]
    frame_sizes = [item["frameSize"] for item in non_empty if item.get("frameSize")]
    median_height = float(statistics.median(heights))
    return {
        "frames": len(measurements),
        "nonEmptyFrames": len(non_empty),
        "frameSize": frame_sizes[0] if frame_sizes and all(size == frame_sizes[0] for size in frame_sizes) else None,
        "visibleWidthRange": [min(widths), max(widths)],
        "visibleHeightRange": [min(heights), max(heights)],
        "visibleBottomYRange": [min(bottoms), max(bottoms)],
        "visibleCenterXRange": [min(centers), max(centers)],
        "medianVisibleWidth": float(statistics.median(widths)),
        "medianVisibleHeight": median_height,
        "medianBottomY": float(statistics.median(bottoms)),
        "medianCenterX": float(statistics.median(centers)),
        "maxVisibleWidth": max(widths),
        "maxVisibleHeight": max(heights),
        "intraHeightDriftPct": ((max(heights) - min(heights)) / median_height) if median_height else None,
    }


def prompt_guidance_for_contract(contract: dict[str, Any]) -> list[str]:
    runtime_cell = contract.get("runtimeCell") or [FRAME_WIDTH, FRAME_HEIGHT]
    target_height = contract.get("targetVisibleHeight")
    bottom_y = contract.get("targetBottomY")
    pivot = contract.get("pivot") or "base-center"
    guidance = [
        "Use a locked camera: no zoom, pan, crop, or camera push-in/out.",
        "Keep the same apparent sprite scale as the input reference for the whole clip.",
        f"Keep the sprite's {pivot} fixed; motion should come from the action, not from sliding the whole sprite around the frame.",
        "Keep the first and final frames close to the same scale and placement so the result can be packed into a game spritesheet.",
    ]
    if target_height:
        guidance.append(
            f"After processing, the sprite should remain about {target_height}px tall inside a {runtime_cell[0]}x{runtime_cell[1]} runtime cell; treat this as scale guidance, not visible text."
        )
    if bottom_y is not None:
        guidance.append(f"Keep the contact/base point visually stable; the intended runtime bottom anchor is y={bottom_y}.")
    return guidance


def append_size_contract_prompt(prompt: str, contract: dict[str, Any] | None) -> str:
    if not contract:
        return prompt
    guidance = prompt_guidance_for_contract(contract)
    lines = "\n".join(f"- {line}" for line in guidance)
    return f"""{prompt.rstrip()}

Size and scale contract:
{lines}

Do not render guides, labels, rulers, bounding boxes, or measurement marks.
"""


def _contract_checks(summary: dict[str, Any], contract: dict[str, Any]) -> list[dict[str, Any]]:
    tolerances = {**DEFAULT_TOLERANCES, **dict(contract.get("tolerances") or {})}
    checks: list[dict[str, Any]] = []
    if summary.get("nonEmptyFrames", 0) == 0:
        return [{"name": "non-empty-frames", "status": "warn", "message": "No non-empty frames were found."}]

    target_height = _optional_number(contract.get("targetVisibleHeight"))
    median_height = _optional_number(summary.get("medianVisibleHeight"))
    max_target_height_drift = _optional_number(tolerances.get("maxTargetHeightDriftPct"))
    if target_height and median_height and max_target_height_drift is not None:
        observed_range = summary["visibleHeightRange"]
        drift = max(abs(observed_range[0] - target_height), abs(observed_range[1] - target_height)) / target_height
        checks.append(
            _check(
                "target-visible-height",
                drift <= max_target_height_drift,
                f"height drift {drift:.1%} <= {max_target_height_drift:.1%}",
                f"height drift {drift:.1%} > {max_target_height_drift:.1%}",
                observed=observed_range,
                target=target_height,
            )
        )

    intra_height_drift = _optional_number(summary.get("intraHeightDriftPct"))
    max_intra_height_drift = _optional_number(tolerances.get("maxIntraHeightDriftPct"))
    if intra_height_drift is not None and max_intra_height_drift is not None:
        checks.append(
            _check(
                "intra-sequence-height",
                intra_height_drift <= max_intra_height_drift,
                f"intra-height drift {intra_height_drift:.1%} <= {max_intra_height_drift:.1%}",
                f"intra-height drift {intra_height_drift:.1%} > {max_intra_height_drift:.1%}",
                observed=summary.get("visibleHeightRange"),
                target=max_intra_height_drift,
            )
        )

    target_bottom = _optional_number(contract.get("targetBottomY"))
    max_bottom_drift = _optional_number(tolerances.get("maxBottomDriftPx"))
    if target_bottom is not None and max_bottom_drift is not None:
        observed_range = summary["visibleBottomYRange"]
        drift_px = max(abs(observed_range[0] - target_bottom), abs(observed_range[1] - target_bottom))
        checks.append(
            _check(
                "target-bottom-y",
                drift_px <= max_bottom_drift,
                f"bottom drift {drift_px:.0f}px <= {max_bottom_drift:.0f}px",
                f"bottom drift {drift_px:.0f}px > {max_bottom_drift:.0f}px",
                observed=observed_range,
                target=target_bottom,
            )
        )

    max_width = _optional_number(contract.get("maxVisibleWidth"))
    max_width_overflow = _optional_number(tolerances.get("maxWidthOverflowPct"))
    if max_width and max_width_overflow is not None:
        observed_max = _optional_number(summary.get("maxVisibleWidth"))
        overflow = max(0.0, ((observed_max or 0) - max_width) / max_width)
        checks.append(
            _check(
                "max-visible-width",
                overflow <= max_width_overflow,
                f"width overflow {overflow:.1%} <= {max_width_overflow:.1%}",
                f"width overflow {overflow:.1%} > {max_width_overflow:.1%}",
                observed=summary.get("visibleWidthRange"),
                target=max_width,
            )
        )

    target_center = _optional_number(contract.get("targetCenterX"))
    max_center_drift = _optional_number(tolerances.get("maxCenterDriftPx"))
    if target_center is not None and max_center_drift is not None:
        observed_range = summary["visibleCenterXRange"]
        drift_px = max(abs(observed_range[0] - target_center), abs(observed_range[1] - target_center))
        checks.append(
            _check(
                "target-center-x",
                drift_px <= max_center_drift,
                f"center drift {drift_px:.0f}px <= {max_center_drift:.0f}px",
                f"center drift {drift_px:.0f}px > {max_center_drift:.0f}px",
                observed=observed_range,
                target=target_center,
            )
        )
    return checks


def _measure_image_or_sheet(source: Path, *, cell_size: tuple[int, int]) -> list[dict[str, Any]]:
    image = Image.open(source).convert("RGBA")
    cell_w, cell_h = cell_size
    if image.width >= cell_w and image.height >= cell_h and image.width % cell_w == 0 and image.height % cell_h == 0:
        columns = image.width // cell_w
        rows = image.height // cell_h
        measurements = []
        for row in range(rows):
            for col in range(columns):
                index = row * columns + col + 1
                cell = image.crop((col * cell_w, row * cell_h, (col + 1) * cell_w, (row + 1) * cell_h))
                measurements.append(_measure_rgba(cell, label=f"frame-{index:02d}", source=str(source), frame_size=(cell_w, cell_h)))
        return measurements
    return [_measure_rgba(image, label=source.name, source=str(source), frame_size=(image.width, image.height))]


def _measure_image(source: Path, *, label: str) -> dict[str, Any]:
    image = Image.open(source).convert("RGBA")
    return _measure_rgba(image, label=label, source=str(source), frame_size=(image.width, image.height))


def _measure_rgba(image: Image.Image, *, label: str, source: str, frame_size: tuple[int, int]) -> dict[str, Any]:
    bbox = image.getchannel("A").getbbox()
    record: dict[str, Any] = {
        "frame": label,
        "source": source,
        "frameSize": [frame_size[0], frame_size[1]],
    }
    if bbox is None:
        record["empty"] = True
        return record
    left, top, right, bottom = bbox
    record.update(
        {
            "empty": False,
            "alphaBBox": [left, top, right, bottom],
            "visibleWidth": right - left,
            "visibleHeight": bottom - top,
            "visibleCenterX": (left + right - 1) / 2,
            "visibleBottomY": bottom - 1,
        }
    )
    return record


def _contract_brief(contract: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "name",
        "source",
        "runtimeCell",
        "anchorPolicy",
        "pivot",
        "targetVisibleHeight",
        "targetVisibleWidth",
        "maxVisibleWidth",
        "targetBottomY",
        "targetCenterX",
        "tolerances",
    ]
    return {key: contract.get(key) for key in keys if key in contract}


def _cell_size(contract: dict[str, Any]) -> tuple[int, int]:
    cell = contract.get("runtimeCell") or [FRAME_WIDTH, FRAME_HEIGHT]
    return int(cell[0]), int(cell[1])


def _optional_number(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _check(
    name: str,
    passed: bool,
    pass_message: str,
    warn_message: str,
    *,
    observed: object,
    target: object,
) -> dict[str, Any]:
    return {
        "name": name,
        "status": "pass" if passed else "warn",
        "message": pass_message if passed else warn_message,
        "observed": observed,
        "target": target,
    }


def _parse_cell(value: str) -> tuple[int, int]:
    parts = value.lower().split("x")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"cell must be WxH, got: {value!r}")
    try:
        width, height = int(parts[0]), int(parts[1])
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"cell must be WxH integers, got: {value!r}") from exc
    return width, height


def _cmd_derive(args: argparse.Namespace) -> int:
    derive_size_contract(
        args.source,
        out=args.out,
        cell_size=args.cell,
        frame_glob=args.frame_glob,
        action=args.action,
        direction=args.direction,
        anchor_policy=args.anchor_policy,
        pivot=args.pivot,
    )
    print(args.out.read_text(encoding="utf-8"))
    return 0


def _cmd_audit(args: argparse.Namespace) -> int:
    contract = load_size_contract(args.contract)
    report = audit_size_contract(args.source, contract, out=args.out, frame_glob=args.frame_glob)
    print(json.dumps(report, indent=2))
    if args.strict and report["status"] != "pass":
        return 1
    return 0


def _cmd_prompt(args: argparse.Namespace) -> int:
    contract = load_size_contract(args.contract)
    for line in prompt_guidance_for_contract(contract):
        print(f"- {line}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Derive, audit, and prompt-guide a sprite size registration contract.",
    )
    sub = parser.add_subparsers(dest="command", required=False)

    p_derive = sub.add_parser("derive", help="Derive a size contract from one approved sheet/frame-dir.")
    p_derive.add_argument("--source", type=Path, required=True, help="PNG sheet/frame or directory of frames.")
    p_derive.add_argument("--out", type=Path, required=True, help="Where to write contract.json.")
    p_derive.add_argument("--action", default=None)
    p_derive.add_argument("--direction", default=None)
    p_derive.add_argument("--pivot", default="base-center", choices=["foot-center", "base-center"])
    p_derive.add_argument("--anchor-policy", default="grounded", choices=["grounded", "preserve-motion"])
    p_derive.add_argument("--cell", type=_parse_cell, default=(FRAME_WIDTH, FRAME_HEIGHT), help="Cell size WxH (default 256x256).")
    p_derive.add_argument("--frame-glob", default="frame-*.png")
    p_derive.set_defaults(func=_cmd_derive)

    p_audit = sub.add_parser("audit", help="Audit a downstream sheet/frame-dir against a contract.")
    p_audit.add_argument("--source", type=Path, required=True)
    p_audit.add_argument("--contract", type=Path, required=True)
    p_audit.add_argument("--out", type=Path, default=None)
    p_audit.add_argument("--frame-glob", default="frame-*.png")
    p_audit.add_argument("--strict", action="store_true", help="Exit 1 if status != pass.")
    p_audit.set_defaults(func=_cmd_audit)

    p_prompt = sub.add_parser("prompt", help="Print the guidance lines for a contract.")
    p_prompt.add_argument("--contract", type=Path, required=True)
    p_prompt.set_defaults(func=_cmd_prompt)

    return parser


def _selftest() -> int:
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="size_contract_selftest_"))

    rect_w, rect_h = 80, 120
    foot_y = 250  # feet near y=250

    def make_frame(path: Path, scale: float = 1.0) -> None:
        img = Image.new("RGBA", (FRAME_WIDTH, FRAME_HEIGHT), (0, 0, 0, 0))
        w = round(rect_w * scale)
        h = round(rect_h * scale)
        left = (FRAME_WIDTH - w) // 2
        top = foot_y - h  # bottom edge of rect at foot_y (exclusive)
        for y in range(top, foot_y):
            for x in range(left, left + w):
                img.putpixel((x, y), (200, 60, 60, 255))
        path.parent.mkdir(parents=True, exist_ok=True)
        img.save(path)

    # --- pass case: 3 same-size frames ---
    pass_dir = tmp / "approved"
    for i in range(1, 4):
        make_frame(pass_dir / f"frame-{i:02d}.png")

    contract_path = tmp / "contract.json"
    derive_size_contract(pass_dir, out=contract_path, action="idle", direction="south")
    contract = load_size_contract(contract_path)

    # targetVisibleHeight within a few px of rect height
    assert abs(contract["targetVisibleHeight"] - rect_h) <= 3, contract["targetVisibleHeight"]
    # targetBottomY ~ the foot row (bottom-1 == foot_y - 1)
    assert abs(contract["targetBottomY"] - (foot_y - 1)) <= 2, contract["targetBottomY"]
    assert contract["kind"] == "sprite-size-contract"

    pass_report = audit_size_contract(pass_dir, contract)
    assert pass_report["status"] == "pass", pass_report["status"]

    # --- warn case: include a ~70% scaled frame (height drift > 8%) ---
    warn_dir = tmp / "downstream"
    make_frame(warn_dir / "frame-01.png")
    make_frame(warn_dir / "frame-02.png")
    make_frame(warn_dir / "frame-03.png", scale=0.70)

    warn_report = audit_size_contract(warn_dir, contract)
    assert warn_report["status"] == "warn", warn_report["status"]
    height_check = next(c for c in warn_report["checks"] if c["name"] == "target-visible-height")
    assert height_check["status"] == "warn", height_check

    # --- prompt guidance content ---
    guidance = prompt_guidance_for_contract(contract)
    joined = "\n".join(guidance)
    assert "locked camera" in joined, joined
    assert "bottom anchor" in joined, joined

    print("size_contract selftest: OK")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--selftest" in argv:
        return _selftest()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

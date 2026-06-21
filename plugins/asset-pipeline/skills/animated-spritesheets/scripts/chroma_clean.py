#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0", "numpy>=1.26"]
# ///
"""Chroma matte cleanup: key a flat matte to transparency, sweep matte-tinted
fringe, and despill residual matte tint on the edge band.

An alternative to segmentation background removal. Generate sprites on a flat
chroma matte (#00FF00 default, #FF00FF when the subject is green), key the matte
out, then optionally clean the fringe band and despill.
"""

from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageColor


HIGH_GREEN_FRINGE_REMOVAL_RATIO = 0.02


def color_distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return sum((a[index] - b[index]) ** 2 for index in range(3)) ** 0.5


def is_green_screen_pixel(
    pixel: tuple[int, int, int, int],
    *,
    min_green: int = 120,
    dominance: int = 35,
) -> bool:
    red, green, blue, alpha = pixel
    if alpha == 0:
        return False
    return green >= min_green and green - max(red, blue) >= dominance


def keep_largest_components(image: Image.Image, min_area: int) -> Image.Image:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    width, height = rgba.size
    px = rgba.load()
    seen: set[tuple[int, int]] = set()
    components: list[list[tuple[int, int]]] = []

    for y in range(height):
        for x in range(width):
            if (x, y) in seen or alpha.getpixel((x, y)) == 0:
                continue
            queue: deque[tuple[int, int]] = deque([(x, y)])
            seen.add((x, y))
            points: list[tuple[int, int]] = []
            while queue:
                cx, cy = queue.popleft()
                points.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in seen and alpha.getpixel((nx, ny)) > 0:
                        seen.add((nx, ny))
                        queue.append((nx, ny))
            components.append(points)

    out = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    out_px = out.load()
    for component in components:
        if len(component) >= min_area:
            for x, y in component:
                out_px[x, y] = px[x, y]
    return out


def background_reachable_transparency(alpha, width: int, height: int) -> bytearray:
    """Flood transparency inward from the 4 corners/edges.

    Returns a bytearray marking every transparent pixel reachable from the image
    border, so interior matte-colored sprite pixels that became transparent are
    NOT treated as background.
    """
    reachable = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def enqueue(x: int, y: int) -> None:
        index = y * width + x
        if reachable[index] or alpha[x, y] != 0:
            return
        reachable[index] = 1
        queue.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    while queue:
        cx, cy = queue.popleft()
        for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
            if 0 <= nx < width and 0 <= ny < height:
                enqueue(nx, ny)
    return reachable


class _FlatAlpha2D:
    """2D-indexable view over a flat ``transparent candidate`` bytearray.

    ``background_reachable_transparency`` treats ``alpha[x, y] == 0`` as
    transparent (floodable) and non-zero as an opaque barrier, reading via
    ``[x, y]``. Our candidate layer stores ``1`` for transparent candidates and
    ``0`` for foreground, so this view inverts: it returns ``0`` (floodable)
    where the candidate is transparent and ``1`` (barrier) where it is
    foreground, letting the corner flood be reused unchanged.
    """

    def __init__(self, candidate: bytearray, width: int) -> None:
        self._candidate = candidate
        self._width = width

    def __getitem__(self, key: tuple[int, int]) -> int:
        x, y = key
        return 0 if self._candidate[y * self._width + x] else 1


def has_background_transparent_neighbor(
    reachable_alpha: bytearray,
    x: int,
    y: int,
    width: int,
    height: int,
    *,
    radius: int = 1,
) -> bool:
    for ny in range(max(0, y - radius), min(height, y + radius + 1)):
        for nx in range(max(0, x - radius), min(width, x + radius + 1)):
            if nx == x and ny == y:
                continue
            if reachable_alpha[ny * width + nx]:
                return True
    return False


def is_green_matte_rgb(rgb: tuple[int, int, int]) -> bool:
    """Return True when the matte color is strongly green-dominant (legacy green path)."""
    red, green, blue = rgb
    return green >= 180 and green - max(red, blue) >= 80


def chroma_fringe_channels(chroma_rgb: tuple[int, int, int]) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Split RGB channel indices into matte-dominant and matte-suppressed groups.

    Raises ValueError when the matte color cannot be split (e.g. gray or white),
    because fringe detection needs at least one high and one low channel.
    """
    dominant = tuple(index for index in range(3) if chroma_rgb[index] >= 128)
    suppressed = tuple(index for index in range(3) if chroma_rgb[index] < 128)
    if not dominant or not suppressed:
        raise ValueError(
            f"chroma {chroma_rgb} cannot be split into dominant/suppressed channels; "
            "fringe cleanup needs a saturated matte color such as #00FF00 or #FF00FF"
        )
    return dominant, suppressed


def is_keyable_fringe_chroma(chroma_rgb: tuple[int, int, int]) -> bool:
    """Return True when the matte color is saturated enough for fringe cleanup."""
    try:
        dominant, suppressed = chroma_fringe_channels(chroma_rgb)
    except ValueError:
        return False
    low = min(chroma_rgb[index] for index in dominant)
    high = max(chroma_rgb[index] for index in suppressed)
    return low >= 180 and low - high >= 80


def green_fringe_warning(removed: int, kept: int) -> str | None:
    total = removed + kept
    if total <= 0:
        return None
    ratio = removed / total
    if ratio >= HIGH_GREEN_FRINGE_REMOVAL_RATIO:
        return (
            "high green-fringe removal ratio; green foreground details may have been removed. "
            "Use a non-green matte such as #FF00FF or pass --no-green-fringe-cleanup."
        )
    return None


def fringe_warning(removed: int, kept: int, *, chroma_rgb: tuple[int, int, int]) -> str | None:
    """Return a warning when fringe cleanup removed a suspiciously large share of pixels."""
    if is_green_matte_rgb(chroma_rgb):
        return green_fringe_warning(removed, kept)
    total = removed + kept
    if total <= 0:
        return None
    if removed / total >= HIGH_GREEN_FRINGE_REMOVAL_RATIO:
        return (
            "high fringe removal ratio; foreground details close to the matte color may have "
            "been removed. Use a matte color absent from the sprite or pass --no-green-fringe-cleanup."
        )
    return None


def is_keyable_fringe_pixel(
    rgb: tuple[int, int, int],
    dominant: tuple[int, ...],
    suppressed: tuple[int, ...],
    *,
    min_level: int,
    dominance: int,
) -> bool:
    low = min(rgb[index] for index in dominant)
    high = max(rgb[index] for index in suppressed)
    return low >= min_level and low - high >= dominance


def remove_chroma_fringe(
    image: Image.Image,
    *,
    chroma_rgb: tuple[int, int, int] = (0, 255, 0),
    min_level: int = 70,
    dominance: int = 24,
    edge_radius: int = 1,
) -> tuple[Image.Image, dict[str, object]]:
    """Remove matte-tinted fringe pixels that touch background-reachable transparency.

    A pixel is treated as fringe when every matte-dominant channel is at least
    ``min_level`` and exceeds every matte-suppressed channel by ``dominance``.
    For a green matte this reduces exactly to the legacy green-fringe test.
    """
    dominant, suppressed = chroma_fringe_channels(chroma_rgb)
    rgba = image.convert("RGBA")
    width, height = rgba.size
    px = rgba.load()
    alpha = rgba.getchannel("A").load()
    reachable_alpha = background_reachable_transparency(alpha, width, height)
    out = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    out_px = out.load()
    removed = 0
    kept = 0
    for y in range(height):
        for x in range(width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            rgb = (r, g, b)
            low = min(rgb[index] for index in dominant)
            high = max(rgb[index] for index in suppressed)
            if (
                has_background_transparent_neighbor(reachable_alpha, x, y, width, height, radius=edge_radius)
                and low >= min_level
                and low - high >= dominance
            ):
                removed += 1
                continue
            out_px[x, y] = (r, g, b, a)
            kept += 1
    bbox = out.getchannel("A").getbbox()
    warning = fringe_warning(removed, kept, chroma_rgb=chroma_rgb)
    return out, {
        "chromaRgb": list(chroma_rgb),
        "removedFringePixels": removed,
        "keptPixels": kept,
        "removedToKeptRatio": removed / max(1, kept),
        "minLevel": min_level,
        "dominance": dominance,
        "edgeRadius": edge_radius,
        "bbox": list(bbox) if bbox else None,
        "warning": warning,
    }


def _near_transparent_mask(alpha: np.ndarray, radius: int) -> np.ndarray:
    """Return a boolean mask of pixels within `radius` (4-connected) of a transparent pixel."""
    near = alpha == 0
    for _ in range(max(0, radius)):
        grown = near.copy()
        grown[1:, :] |= near[:-1, :]
        grown[:-1, :] |= near[1:, :]
        grown[:, 1:] |= near[:, :-1]
        grown[:, :-1] |= near[:, 1:]
        near = grown
    return near


def despill_chroma(
    image: Image.Image,
    *,
    chroma_rgb: tuple[int, int, int],
    edge_radius: int = 2,
    band_only: bool = True,
) -> tuple[Image.Image, dict[str, object]]:
    """Neutralize matte-color spill by clamping matte-dominant channels toward the suppressed level.

    For a green matte this is the classic despill ``g = min(g, max(r, b))``. The
    generalized form clamps every matte-dominant channel down to the maximum of
    the matte-suppressed channels, which removes the matte tint without deleting
    pixels or altering geometry. When ``band_only`` is set, only opaque pixels
    within ``edge_radius`` of a transparent pixel are touched, so interior
    matte-colored detail is left intact.
    """
    dominant, suppressed = chroma_fringe_channels(chroma_rgb)
    rgba = image.convert("RGBA")
    arr = np.asarray(rgba).astype(np.int16)
    rgb = arr[..., :3]
    alpha = arr[..., 3]

    high = rgb[..., list(suppressed)].max(axis=2)
    foreground = alpha > 0
    region = foreground
    if band_only:
        region = foreground & _near_transparent_mask(alpha, edge_radius)

    new_rgb = rgb.copy()
    for channel in dominant:
        clamped = np.minimum(rgb[..., channel], high)
        new_rgb[..., channel] = np.where(region, clamped, rgb[..., channel])

    changed = region & (new_rgb != rgb).any(axis=2)
    spill_removed = int((rgb - new_rgb)[changed].sum()) if changed.any() else 0

    out_arr = arr.copy()
    out_arr[..., :3] = new_rgb
    out = Image.fromarray(out_arr.astype(np.uint8), "RGBA")
    return out, {
        "chromaRgb": list(chroma_rgb),
        "edgeRadius": edge_radius,
        "bandOnly": band_only,
        "despilledPixels": int(changed.sum()),
        "spillRemoved": spill_removed,
    }


def key_matte(
    image: Image.Image,
    *,
    chroma_rgb: tuple[int, int, int] = (0, 255, 0),
    tolerance: float = 90.0,
    keep_largest: bool = False,
    min_component_area: int = 80,
) -> tuple[Image.Image, dict[str, object]]:
    """Key out a flat chroma matte to transparency.

    Pixels within ``tolerance`` (Euclidean RGB distance) of ``chroma_rgb`` become
    candidates. A flood fill from the 4 corners then confines removal to the
    matte that is reachable from the border, so interior matte-colored sprite
    pixels survive. Optionally despeckle by keeping only the largest components.

    The corner flood-fill (background_reachable_transparency) is layered on so
    enclosed matte-colored detail is preserved.
    """
    rgba = image.convert("RGBA")
    width, height = rgba.size
    px = rgba.load()

    # Mark every in-tolerance pixel transparent in a candidate alpha layer.
    candidate_alpha = bytearray(width * height)  # 1 == transparent candidate
    removed_candidates = 0
    for y in range(height):
        for x in range(width):
            r, g, b, a = px[x, y]
            if a == 0:
                candidate_alpha[y * width + x] = 1
                continue
            if color_distance((r, g, b), chroma_rgb) <= tolerance:
                candidate_alpha[y * width + x] = 1
                removed_candidates += 1

    # Flood from the corners so only border-reachable matte is keyed out.
    # background_reachable_transparency reads alpha via [x, y]; wrap the flat
    # candidate layer in that 2D-indexable view so the corner flood is reused
    # verbatim (0 == transparent candidate, propagated; non-zero == foreground).
    reachable = background_reachable_transparency(
        _FlatAlpha2D(candidate_alpha, width), width, height
    )

    out = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    out_px = out.load()
    removed = 0
    kept = 0
    for y in range(height):
        for x in range(width):
            index = y * width + x
            r, g, b, a = px[x, y]
            if reachable[index]:
                if a != 0:
                    removed += 1
                continue
            if a == 0:
                continue
            out_px[x, y] = (r, g, b, a)
            kept += 1

    if keep_largest:
        out = keep_largest_components(out, min_component_area)

    bbox = out.getchannel("A").getbbox()
    return out, {
        "chromaRgb": list(chroma_rgb),
        "tolerance": tolerance,
        "keepLargest": keep_largest,
        "minComponentArea": min_component_area if keep_largest else None,
        "removedPixels": removed,
        "inToleranceCandidates": removed_candidates,
        "keptPixels": kept,
        "bbox": list(bbox) if bbox else None,
    }


def parse_chroma(value: str) -> tuple[int, int, int]:
    rgb = ImageColor.getrgb(value)
    return (rgb[0], rgb[1], rgb[2])


def _iter_inputs(input_path: Path, glob: str) -> list[Path]:
    if input_path.is_dir():
        frames = sorted(input_path.glob(glob))
        if not frames:
            raise SystemExit(f"no files matched {glob} in {input_path}")
        return frames
    if not input_path.exists():
        raise SystemExit(f"input not found: {input_path}")
    return [input_path]


def cmd_key(args: argparse.Namespace) -> None:
    chroma = parse_chroma(args.chroma)
    src = Path(args.input)
    if src.is_dir():
        raise SystemExit("key expects a single PNG; use fringe/despill for directories")
    cleaned, record = key_matte(
        Image.open(src),
        chroma_rgb=chroma,
        tolerance=args.tolerance,
        keep_largest=args.keep_largest,
    )
    out = Path(args.out) if args.out else src.with_name(f"{src.stem}-keyed.png")
    out.parent.mkdir(parents=True, exist_ok=True)
    cleaned.save(out)
    meta = {"input": str(src), "output": str(out), **record}
    (out.with_name("key-metadata.json")).write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(out)


def cmd_fringe(args: argparse.Namespace) -> None:
    chroma = parse_chroma(args.chroma)
    src = Path(args.input)
    frames = _iter_inputs(src, args.glob)
    out_dir = Path(args.out_dir) if args.out_dir else (src if src.is_dir() else src.parent)
    out_dir.mkdir(parents=True, exist_ok=True)

    metadata: list[dict[str, object]] = []
    warnings: list[dict[str, object]] = []
    for frame in frames:
        cleaned, record = remove_chroma_fringe(
            Image.open(frame),
            chroma_rgb=chroma,
            edge_radius=args.edge_radius,
        )
        out = out_dir / frame.name
        cleaned.save(out)
        metadata.append({"input": str(frame), "output": str(out), **record})
        if record.get("warning"):
            warnings.append(
                {
                    "frame": frame.name,
                    "warning": record["warning"],
                    "removedFringePixels": record["removedFringePixels"],
                    "keptPixels": record["keptPixels"],
                    "removedToKeptRatio": record["removedToKeptRatio"],
                }
            )

    (out_dir / "fringe-metadata.json").write_text(
        json.dumps(
            {
                "chromaRgb": list(chroma),
                "edgeRadius": args.edge_radius,
                "highRemovalRatioThreshold": HIGH_GREEN_FRINGE_REMOVAL_RATIO,
                "warnings": warnings,
                "frames": metadata,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(out_dir)


def cmd_despill(args: argparse.Namespace) -> None:
    chroma = parse_chroma(args.chroma)
    src = Path(args.input)
    frames = _iter_inputs(src, args.glob)
    out_dir = Path(args.out_dir) if args.out_dir else (src if src.is_dir() else src.parent)
    out_dir.mkdir(parents=True, exist_ok=True)

    metadata: list[dict[str, object]] = []
    for frame in frames:
        cleaned, record = despill_chroma(
            Image.open(frame),
            chroma_rgb=chroma,
            edge_radius=args.edge_radius,
        )
        out = out_dir / frame.name
        cleaned.save(out)
        metadata.append({"input": str(frame), "output": str(out), **record})

    (out_dir / "despill-metadata.json").write_text(
        json.dumps(
            {
                "chromaRgb": list(chroma),
                "edgeRadius": args.edge_radius,
                "bandOnly": True,
                "frames": metadata,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(out_dir)


def decontaminate_matte(
    image: Image.Image,
    *,
    chroma_rgb: tuple[int, int, int],
    excess: int = 50,
    min_level: int = 100,
) -> tuple[Image.Image, dict[str, object]]:
    """Drop leftover near-pure-matte specks ANYWHERE on the sprite (not just the edge band).

    A dark / low-contrast subject keyed against a bright matte leaves antialiased
    matte-tinted pixels the edge despill misses. This deletes any opaque pixel whose
    matte-dominant channel(s) still exceed its suppressed channel(s) by > ``excess``
    AND are brighter than ``min_level`` — i.e. clearly residual matte. Safe for any
    saturated matte: a real character colour (e.g. a red shirt under a magenta matte)
    is not "near-pure matte", so it survives. Requires a green-character to use a
    non-green matte, exactly like the rest of the chroma path.
    """
    dominant, suppressed = chroma_fringe_channels(chroma_rgb)
    arr = np.array(image.convert("RGBA"))
    a = arr[..., 3]
    rgb = arr[..., :3].astype(np.int16)
    dom_min = rgb[..., list(dominant)].min(axis=-1)
    sup_max = rgb[..., list(suppressed)].max(axis=-1)
    specks = (a > 0) & ((dom_min - sup_max) > excess) & (dom_min > min_level)
    arr[..., 3] = np.where(specks, 0, a).astype(np.uint8)
    return Image.fromarray(arr, "RGBA"), {"specksRemoved": int(specks.sum())}


def _clean_one(src: Path, out: Path, chroma: tuple[int, int, int], tolerance: float,
               fringe_radius: int, despill_radius: int, decontam: bool = True) -> dict[str, object]:
    keyed, key_record = key_matte(Image.open(src), chroma_rgb=chroma, tolerance=tolerance)
    defringed, fringe_record = remove_chroma_fringe(keyed, chroma_rgb=chroma, edge_radius=fringe_radius)
    despilled, despill_record = despill_chroma(defringed, chroma_rgb=chroma, edge_radius=despill_radius)
    decontam_record: dict[str, object] = {"skipped": True}
    if decontam and is_keyable_fringe_chroma(chroma):
        despilled, decontam_record = decontaminate_matte(despilled, chroma_rgb=chroma)
    out.parent.mkdir(parents=True, exist_ok=True)
    despilled.save(out)
    return {"input": str(src), "output": str(out), "chromaRgb": list(chroma),
            "key": key_record, "fringe": fringe_record, "despill": despill_record,
            "decontam": decontam_record}


def cmd_clean(args: argparse.Namespace) -> dict[str, object]:
    """Key THEN fringe THEN despill (the recommended path). Accepts a single PNG or a directory."""
    chroma = parse_chroma(args.chroma)
    decontam = not getattr(args, "no_decontam", False)
    src = Path(args.input)
    if src.is_dir():
        out_dir = Path(args.out_dir) if args.out_dir else src
        frames = [_clean_one(f, out_dir / f.name, chroma, args.tolerance, args.fringe_radius, args.despill_radius, decontam)
                  for f in _iter_inputs(src, args.glob)]
        meta: dict[str, object] = {"inputDir": str(src), "outDir": str(out_dir), "frames": frames}
        (out_dir / "clean-metadata.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        print(out_dir)
        return meta

    out = Path(args.out) if args.out else src.with_name(f"{src.stem}-clean.png")
    meta = _clean_one(src, out, chroma, args.tolerance, args.fringe_radius, args.despill_radius, decontam)
    (out.with_name("clean-metadata.json")).write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(out)
    return meta


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Chroma matte cleanup: key a flat matte to transparency, sweep "
            "matte-tinted fringe, and despill residual tint on the edge band."
        )
    )
    parser.add_argument("--selftest", action="store_true", help="Run self-test on synthetic fixtures and exit.")
    sub = parser.add_subparsers(dest="command")

    common_chroma = dict(default="#00FF00", help="Matte color, e.g. '#00FF00' (default) or '#FF00FF'.")

    p_key = sub.add_parser("key", help="Key the matte out to transparency.")
    p_key.add_argument("--input", required=True)
    p_key.add_argument("--out", default=None)
    p_key.add_argument("--chroma", **common_chroma)
    p_key.add_argument("--tolerance", type=float, default=90.0)
    p_key.add_argument("--keep-largest", action="store_true")
    p_key.set_defaults(func=cmd_key)

    p_fringe = sub.add_parser("fringe", help="Remove matte-tinted fringe pixels on the edge band.")
    p_fringe.add_argument("--input", required=True)
    p_fringe.add_argument("--out-dir", default=None)
    p_fringe.add_argument("--chroma", **common_chroma)
    p_fringe.add_argument("--edge-radius", type=int, default=1)
    p_fringe.add_argument("--glob", default="*.png")
    p_fringe.set_defaults(func=cmd_fringe)

    p_despill = sub.add_parser("despill", help="Despill residual matte tint on the edge band.")
    p_despill.add_argument("--input", required=True)
    p_despill.add_argument("--out-dir", default=None)
    p_despill.add_argument("--chroma", **common_chroma)
    p_despill.add_argument("--edge-radius", type=int, default=2)
    p_despill.add_argument("--glob", default="*.png")
    p_despill.set_defaults(func=cmd_despill)

    p_clean = sub.add_parser("clean", help="Key THEN fringe THEN despill (recommended). Single PNG or a directory.")
    p_clean.add_argument("--input", required=True, help="a PNG, or a directory of frames")
    p_clean.add_argument("--out", default=None, help="output path (single-PNG mode)")
    p_clean.add_argument("--out-dir", default=None, help="output directory (directory mode; defaults to --input)")
    p_clean.add_argument("--glob", default="*.png", help="glob for directory mode")
    p_clean.add_argument("--chroma", **common_chroma)
    p_clean.add_argument("--tolerance", type=float, default=90.0)
    p_clean.add_argument("--fringe-radius", type=int, default=1)
    p_clean.add_argument("--despill-radius", type=int, default=2)
    p_clean.add_argument("--no-decontam", action="store_true",
                         help="skip the global matte speck-removal pass (keep it for dark/low-contrast subjects)")
    p_clean.set_defaults(func=cmd_clean)

    return parser


def selftest() -> None:
    import tempfile

    workdir = Path(tempfile.mkdtemp(prefix="chroma_clean_selftest_"))

    # --- Fixture: 64x64 #00FF00 matte, solid red disk, greenish spill ring. ---
    size = 64
    cx = cy = size // 2
    disk_r = 16
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    arr[..., :] = (0, 255, 0, 255)  # green matte
    yy, xx = np.mgrid[0:size, 0:size]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    disk = dist <= disk_r
    arr[disk] = (255, 0, 0, 255)  # red disk
    # 1px ring of mild greenish spill just outside the disk. The green lead over
    # max(r, b) is below the fringe dominance (24) so the ring survives fringe
    # removal, yet still > 0 so despill (g -> min(g, max(r, b))) reduces it.
    ring = (dist > disk_r) & (dist <= disk_r + 1)
    arr[ring] = (200, 210, 40, 255)
    fixture = Image.fromarray(arr, "RGBA")
    fixture_path = workdir / "fixture.png"
    fixture.save(fixture_path)

    # --- clean (key -> fringe -> despill) ---
    chroma = (0, 255, 0)
    keyed, _ = key_matte(fixture, chroma_rgb=chroma, tolerance=90.0)
    defringed, _ = remove_chroma_fringe(keyed, chroma_rgb=chroma, edge_radius=1)
    despilled, despill_record = despill_chroma(defringed, chroma_rgb=chroma, edge_radius=2)

    out_px = despilled.load()
    # Corners keyed out (alpha 0).
    for corner in ((0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)):
        assert out_px[corner][3] == 0, f"corner {corner} not transparent: {out_px[corner]}"
    # Disk center stays opaque red.
    center_px = out_px[cx, cy]
    assert center_px[3] == 255, f"center alpha not opaque: {center_px}"
    assert center_px[0] == 255 and center_px[1] == 0 and center_px[2] == 0, f"center not red: {center_px}"
    # Despill reduced green on the ring band.
    assert int(despill_record["despilledPixels"]) > 0, "despill removed no pixels"
    assert int(despill_record["spillRemoved"]) > 0, "despill removed no spill amount"

    # --- green-subject guard ---
    assert is_keyable_fringe_chroma((0xFF, 0x00, 0xFF)) is True, "magenta should be keyable fringe chroma"
    assert is_keyable_fringe_chroma((0, 255, 0)) is True, "green should be keyable fringe chroma"
    assert is_keyable_fringe_chroma((128, 128, 128)) is False, "gray should NOT be keyable"

    # High removed/kept ratio triggers a non-empty fringe warning (green path).
    warn = fringe_warning(removed=100, kept=100, chroma_rgb=(0, 255, 0))
    assert warn, "high green ratio should warn"
    assert isinstance(warn, str) and len(warn) > 0, "warning must be a non-empty string"
    # Non-green matte path also warns at a high ratio.
    warn_m = fringe_warning(removed=100, kept=100, chroma_rgb=(0xFF, 0x00, 0xFF))
    assert warn_m and isinstance(warn_m, str), "high magenta ratio should warn"
    # Low ratio does not warn.
    assert fringe_warning(removed=0, kept=100, chroma_rgb=(0, 255, 0)) is None, "low ratio must not warn"

    # --- chroma_fringe_channels split + green despill identity (g = min(g, max(r,b))) ---
    dom, sup = chroma_fringe_channels((0, 255, 0))
    assert dom == (1,) and sup == (0, 2), f"green split wrong: {dom} {sup}"

    # --- exercise CLI cmd_clean end-to-end (writes metadata) ---
    ns = argparse.Namespace(
        input=str(fixture_path),
        out=str(workdir / "clean.png"),
        chroma="#00FF00",
        tolerance=90.0,
        fringe_radius=1,
        despill_radius=2,
    )
    meta = cmd_clean(ns)
    assert int(meta["despill"]["despilledPixels"]) > 0, "cmd_clean despill did nothing"
    assert (workdir / "clean-metadata.json").exists(), "clean metadata not written"

    print("chroma_clean selftest: OK")


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    if not getattr(args, "command", None):
        parser.print_help()
        raise SystemExit(2)
    args.func(args)


if __name__ == "__main__":
    main()

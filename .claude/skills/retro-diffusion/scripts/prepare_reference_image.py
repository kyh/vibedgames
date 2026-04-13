#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

from PIL import Image


def _parse_hex_color(value: str) -> tuple[int, int, int]:
    text = value.strip()
    if text.startswith("#"):
        text = text[1:]
    if len(text) != 6:
        raise argparse.ArgumentTypeError("Expected a 6-digit hex color like #808080")
    try:
        return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Expected a 6-digit hex color like #808080") from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prepare an RGB Retro Diffusion reference image from a local sprite asset.")
    parser.add_argument("--input", type=Path, required=True, help="Source image.")
    parser.add_argument("--output", type=Path, required=True, help="Prepared output image.")
    parser.add_argument("--matte-color", type=_parse_hex_color, default=(128, 128, 128), help="RGB matte color as #RRGGBB.")
    parser.add_argument("--target-size", type=int, default=None, help="Optional square target size.")
    parser.add_argument("--fit", choices=["contain", "cover"], default="contain", help="How to fit when target-size is used.")
    parser.add_argument("--trim-alpha", action="store_true", help="Crop to the visible alpha bounds before resizing.")
    parser.add_argument("--padding-ratio", type=float, default=0.0, help="Extra padding around the trimmed sprite, as a fraction of trimmed size.")
    return parser


def _prepare_image(
    input_path: Path,
    matte_color: tuple[int, int, int],
    target_size: int | None,
    fit: str,
    trim_alpha: bool,
    padding_ratio: float,
) -> Image.Image:
    with Image.open(input_path) as source:
        source_rgba = source.convert("RGBA")
        if trim_alpha:
            bbox = source_rgba.getchannel("A").getbbox()
            if bbox:
                source_rgba = source_rgba.crop(bbox)
        if padding_ratio > 0:
            pad_x = round(source_rgba.width * padding_ratio)
            pad_y = round(source_rgba.height * padding_ratio)
            padded = Image.new(
                "RGBA",
                (source_rgba.width + pad_x * 2, source_rgba.height + pad_y * 2),
                matte_color + (0,),
            )
            padded.alpha_composite(source_rgba, (pad_x, pad_y))
            source_rgba = padded
        base = Image.new("RGBA", source_rgba.size, matte_color + (255,))
        flattened = Image.alpha_composite(base, source_rgba).convert("RGB")

    if target_size is None:
        return flattened

    if fit == "contain":
        scale = min(target_size / flattened.width, target_size / flattened.height)
    else:
        scale = max(target_size / flattened.width, target_size / flattened.height)
    resized = flattened.resize(
        (max(1, round(flattened.width * scale)), max(1, round(flattened.height * scale))),
        Image.Resampling.NEAREST,
    )
    canvas = Image.new("RGB", (target_size, target_size), matte_color)
    offset_x = (target_size - resized.width) // 2
    offset_y = (target_size - resized.height) // 2
    canvas.paste(resized, (offset_x, offset_y))
    return canvas


def main(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    image = _prepare_image(
        args.input,
        args.matte_color,
        args.target_size,
        args.fit,
        args.trim_alpha,
        args.padding_ratio,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output, format="PNG")
    print(args.output)


if __name__ == "__main__":
    main()

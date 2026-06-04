#!/usr/bin/env python3
"""
Aseprite inspector: parse .ase/.aseprite structure and (optionally) infer pixel/tile-derived facts.

Goals:
- Safe: chunk-driven parsing; unknown chunks are skipped by size.
- Useful: emits JSON describing header/frames/layers/cels/tags/slices/tilesets/palettes/userdata.
- Optional inference: --decode-cels to zlib-decompress cel/tilemap data and compute tight bounds.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import struct
import sys
import uuid as uuidlib
import zlib
from typing import Any, Dict, List, Optional, Tuple


class ParseError(Exception):
    pass


def _u8(b: bytes, o: int) -> int:
    return b[o]


def _read_exact(f, n: int) -> bytes:
    data = f.read(n)
    if len(data) != n:
        raise ParseError(f"Unexpected EOF (wanted {n} bytes, got {len(data)}).")
    return data


def _read_struct(fmt: str, data: bytes, offset: int = 0) -> Tuple[Any, ...]:
    size = struct.calcsize(fmt)
    if offset + size > len(data):
        raise ParseError("Buffer underrun while unpacking.")
    return struct.unpack_from(fmt, data, offset)


@dataclasses.dataclass
class Reader:
    data: bytes
    off: int = 0

    def remaining(self) -> int:
        return len(self.data) - self.off

    def take(self, n: int) -> bytes:
        if self.off + n > len(self.data):
            raise ParseError("Chunk underrun while reading.")
        out = self.data[self.off : self.off + n]
        self.off += n
        return out

    def u8(self) -> int:
        (v,) = _read_struct("<B", self.data, self.off)
        self.off += 1
        return int(v)

    def u16(self) -> int:
        (v,) = _read_struct("<H", self.data, self.off)
        self.off += 2
        return int(v)

    def s16(self) -> int:
        (v,) = _read_struct("<h", self.data, self.off)
        self.off += 2
        return int(v)

    def u32(self) -> int:
        (v,) = _read_struct("<I", self.data, self.off)
        self.off += 4
        return int(v)

    def s32(self) -> int:
        (v,) = _read_struct("<i", self.data, self.off)
        self.off += 4
        return int(v)

    def u64(self) -> int:
        (v,) = _read_struct("<Q", self.data, self.off)
        self.off += 8
        return int(v)

    def s64(self) -> int:
        (v,) = _read_struct("<q", self.data, self.off)
        self.off += 8
        return int(v)

    def fixed_16_16(self) -> float:
        raw = self.s32()
        return float(raw) / 65536.0

    def string(self) -> str:
        n = self.u16()
        b = self.take(n)
        return b.decode("utf-8", errors="replace")

    def uuid(self) -> str:
        b = self.take(16)
        return str(uuidlib.UUID(bytes=bytes(b)))


def _decompress_limited(data: bytes, limit_bytes: int) -> bytes:
    # Avoid unbounded decompression.
    d = zlib.decompressobj()
    out_parts: List[bytes] = []
    total = 0
    i = 0
    chunk_size = 64 * 1024
    while i < len(data):
        piece = d.decompress(data[i : i + chunk_size])
        i += chunk_size
        if piece:
            out_parts.append(piece)
            total += len(piece)
            if total > limit_bytes:
                raise ParseError(f"Decompressed data exceeds limit ({limit_bytes} bytes).")
    tail = d.flush()
    if tail:
        out_parts.append(tail)
        total += len(tail)
        if total > limit_bytes:
            raise ParseError(f"Decompressed data exceeds limit ({limit_bytes} bytes).")
    return b"".join(out_parts)


def _bytes_per_pixel(color_depth_bpp: int) -> int:
    if color_depth_bpp == 32:
        return 4
    if color_depth_bpp == 16:
        return 2
    if color_depth_bpp == 8:
        return 1
    raise ParseError(f"Unsupported color depth: {color_depth_bpp} bpp")


def _infer_bounds_from_pixels(
    raw: bytes,
    width: int,
    height: int,
    color_depth_bpp: int,
    indexed_transparent_index: int,
    treat_index0_transparent: bool,
) -> Optional[Dict[str, int]]:
    bpp = _bytes_per_pixel(color_depth_bpp)
    expected = width * height * bpp
    if len(raw) != expected:
        raise ParseError(f"Unexpected decoded pixel length (got {len(raw)}, expected {expected}).")

    min_x = width
    min_y = height
    max_x = -1
    max_y = -1

    if color_depth_bpp == 32:
        # RGBA, alpha is 4th byte.
        for y in range(height):
            row_off = y * width * 4
            for x in range(width):
                a = raw[row_off + x * 4 + 3]
                if a:
                    if x < min_x:
                        min_x = x
                    if y < min_y:
                        min_y = y
                    if x > max_x:
                        max_x = x
                    if y > max_y:
                        max_y = y
    elif color_depth_bpp == 16:
        # Grayscale: value, alpha.
        for y in range(height):
            row_off = y * width * 2
            for x in range(width):
                a = raw[row_off + x * 2 + 1]
                if a:
                    if x < min_x:
                        min_x = x
                    if y < min_y:
                        min_y = y
                    if x > max_x:
                        max_x = x
                    if y > max_y:
                        max_y = y
    elif color_depth_bpp == 8:
        transparent = indexed_transparent_index
        for y in range(height):
            row_off = y * width
            for x in range(width):
                idx = raw[row_off + x]
                if idx == transparent:
                    continue
                if treat_index0_transparent and idx == 0:
                    continue
                if x < min_x:
                    min_x = x
                if y < min_y:
                    min_y = y
                if x > max_x:
                    max_x = x
                if y > max_y:
                    max_y = y

    if max_x < 0 or max_y < 0:
        return None
    return {"x": min_x, "y": min_y, "w": (max_x - min_x + 1), "h": (max_y - min_y + 1)}


def _parse_properties_map(r: Reader) -> Dict[str, Any]:
    count = r.u32()
    props: Dict[str, Any] = {}
    for _ in range(count):
        name = r.string()
        type_id = r.u16()
        props[name] = _parse_typed_value(r, type_id)
    return props


def _parse_vector(r: Reader) -> List[Any]:
    n = r.u32()
    elem_type = r.u16()
    out: List[Any] = []
    if elem_type == 0:
        for _ in range(n):
            t = r.u16()
            out.append(_parse_typed_value(r, t))
        return out
    for _ in range(n):
        out.append(_parse_typed_value(r, elem_type))
    return out


def _parse_typed_value(r: Reader, type_id: int) -> Any:
    if type_id == 0x0001:  # bool
        return bool(r.u8())
    if type_id == 0x0002:  # int8
        (v,) = _read_struct("<b", r.data, r.off)
        r.off += 1
        return int(v)
    if type_id == 0x0003:  # uint8
        return int(r.u8())
    if type_id == 0x0004:  # int16
        return int(r.s16())
    if type_id == 0x0005:  # uint16
        return int(r.u16())
    if type_id == 0x0006:  # int32
        return int(r.s32())
    if type_id == 0x0007:  # uint32
        return int(r.u32())
    if type_id == 0x0008:  # int64
        return int(r.s64())
    if type_id == 0x0009:  # uint64
        return int(r.u64())
    if type_id == 0x000A:  # FIXED
        return r.fixed_16_16()
    if type_id == 0x000B:  # FLOAT
        (v,) = _read_struct("<f", r.data, r.off)
        r.off += 4
        return float(v)
    if type_id == 0x000C:  # DOUBLE
        (v,) = _read_struct("<d", r.data, r.off)
        r.off += 8
        return float(v)
    if type_id == 0x000D:  # STRING
        return r.string()
    if type_id == 0x000E:  # POINT
        return {"x": r.s32(), "y": r.s32()}
    if type_id == 0x000F:  # SIZE
        return {"w": r.s32(), "h": r.s32()}
    if type_id == 0x0010:  # RECT
        x = r.s32()
        y = r.s32()
        w = r.s32()
        h = r.s32()
        return {"x": x, "y": y, "w": w, "h": h}
    if type_id == 0x0011:  # vector
        return _parse_vector(r)
    if type_id == 0x0012:  # nested properties map
        return _parse_properties_map(r)
    if type_id == 0x0013:  # UUID
        return r.uuid()

    # Unknown: return raw bytes (best-effort) by stopping parse? We can't know size.
    raise ParseError(f"Unsupported property type: 0x{type_id:04x}")


def inspect(path: str, *, decode_cels: bool, max_decompress_mib: int, palette_entries: int, treat_index0_transparent: bool) -> Dict[str, Any]:
    with open(path, "rb") as f:
        header = _read_exact(f, 128)

        (
            file_size,
            magic,
            frames,
            width,
            height,
            color_depth,
            flags,
            speed_deprecated,
        ) = _read_struct("<IHHHHHIH", header, 0)
        if magic != 0xA5E0:
            raise ParseError(f"Bad magic 0x{magic:04x} (expected 0xA5E0).")

        transparent_index = _u8(header, 16 + 4 + 4)  # after speed + 2x DWORD zeros
        # Safer: unpack exact offsets from spec:
        # 0: file_size(4)
        # 4: magic(2)
        # 6: frames(2)
        # 8: w(2)
        # 10: h(2)
        # 12: color_depth(2)
        # 14: flags(4)
        # 18: speed(2)
        # 20: reserved DWORD
        # 24: reserved DWORD
        # 28: transparent index BYTE
        transparent_index = _u8(header, 28)
        (num_colors,) = _read_struct("<H", header, 32)
        pixel_w = _u8(header, 34)
        pixel_h = _u8(header, 35)
        (grid_x, grid_y, grid_w, grid_h) = _read_struct("<hhHH", header, 36)

        header_info: Dict[str, Any] = {
            "fileSize": int(file_size),
            "frames": int(frames),
            "width": int(width),
            "height": int(height),
            "colorDepthBpp": int(color_depth),
            "flags": int(flags),
            "speedDeprecatedMs": int(speed_deprecated),
            "transparentIndex": int(transparent_index),
            "numColors": int(num_colors) if num_colors != 0 else 256,
            "pixelRatio": {"w": int(pixel_w) or 1, "h": int(pixel_h) or 1},
            "grid": {"x": int(grid_x), "y": int(grid_y), "w": int(grid_w), "h": int(grid_h)},
        }

        has_layer_uuids = bool(flags & 4)

        layers: List[Dict[str, Any]] = []
        tags: List[Dict[str, Any]] = []
        slices: List[Dict[str, Any]] = []
        tilesets: List[Dict[str, Any]] = []
        palettes: List[Dict[str, Any]] = []
        external_files: List[Dict[str, Any]] = []
        color_profile: Optional[Dict[str, Any]] = None
        unknown_chunks: List[Dict[str, Any]] = []

        frames_out: List[Dict[str, Any]] = []

        # For attaching user data to the last seen object.
        last_object_ref: Optional[Tuple[str, int]] = None  # (kind, index)
        pending_tag_user_data: List[int] = []

        # Decode support: store cel bounds by (frame_index, layer_index).
        decoded_cel_bounds: Dict[Tuple[int, int], Optional[Dict[str, int]]] = {}
        decoded_cel_dims: Dict[Tuple[int, int], Tuple[int, int]] = {}
        cel_index_by_frame_layer: Dict[Tuple[int, int], int] = {}

        for frame_i in range(frames):
            frame_header = _read_exact(f, 16)
            (bytes_in_frame, frame_magic, old_chunks, frame_duration, _r1, new_chunks) = _read_struct(
                "<IHHH2sI", frame_header, 0
            )
            if frame_magic != 0xF1FA:
                raise ParseError(f"Bad frame magic 0x{frame_magic:04x} at frame {frame_i}.")

            if old_chunks == 0xFFFF:
                chunk_count = int(new_chunks)
            elif new_chunks != 0:
                chunk_count = int(new_chunks)
            else:
                chunk_count = int(old_chunks)

            frame_out: Dict[str, Any] = {
                "bytesInFrame": int(bytes_in_frame),
                "durationMs": int(frame_duration),
                "chunks": [],
            }

            for _ in range(chunk_count):
                chunk_header = _read_exact(f, 6)
                (chunk_size, chunk_type) = _read_struct("<IH", chunk_header, 0)
                if chunk_size < 6:
                    raise ParseError(f"Invalid chunk size {chunk_size}.")
                chunk_data = _read_exact(f, int(chunk_size) - 6)
                r = Reader(chunk_data)

                chunk_summary = {"type": int(chunk_type), "size": int(chunk_size)}

                if chunk_type == 0x2004:  # Layer
                    flags_l = r.u16()
                    layer_type = r.u16()
                    child_level = r.u16()
                    _ = r.u16()
                    _ = r.u16()
                    blend_mode = r.u16()
                    opacity = r.u8()
                    r.take(3)
                    name = r.string()
                    tileset_index = None
                    if layer_type == 2:
                        tileset_index = r.u32()
                    layer_uuid = None
                    if has_layer_uuids:
                        layer_uuid = r.uuid()
                    layer = {
                        "flags": int(flags_l),
                        "type": int(layer_type),
                        "childLevel": int(child_level),
                        "blendMode": int(blend_mode),
                        "opacity": int(opacity),
                        "name": name,
                    }
                    if tileset_index is not None:
                        layer["tilesetIndex"] = int(tileset_index)
                    if layer_uuid is not None:
                        layer["uuid"] = layer_uuid
                    layers.append(layer)
                    last_object_ref = ("layer", len(layers) - 1)
                    chunk_summary["parsed"] = {"layerIndex": len(layers) - 1, "name": name}

                elif chunk_type == 0x2005:  # Cel
                    layer_index = r.u16()
                    x = r.s16()
                    y = r.s16()
                    cel_opacity = r.u8()
                    cel_type = r.u16()
                    z_index = r.s16()
                    r.take(5)

                    cel: Dict[str, Any] = {
                        "layerIndex": int(layer_index),
                        "x": int(x),
                        "y": int(y),
                        "opacity": int(cel_opacity),
                        "celType": int(cel_type),
                        "zIndex": int(z_index),
                    }

                    if cel_type == 0:  # raw
                        w = r.u16()
                        h = r.u16()
                        cel["w"] = int(w)
                        cel["h"] = int(h)
                        cel["rawBytes"] = int(r.remaining())
                        # Skip pixels.
                        r.take(r.remaining())
                    elif cel_type == 1:  # linked
                        link_frame = r.u16()
                        cel["linkFrame"] = int(link_frame)
                    elif cel_type == 2:  # compressed image
                        w = r.u16()
                        h = r.u16()
                        cel["w"] = int(w)
                        cel["h"] = int(h)
                        compressed = r.take(r.remaining())
                        cel["compressedBytes"] = len(compressed)

                        if decode_cels:
                            bpp = _bytes_per_pixel(color_depth)
                            expected = int(w) * int(h) * bpp
                            limit = min(max_decompress_mib * 1024 * 1024, max(expected, 1))
                            raw = _decompress_limited(compressed, limit_bytes=limit)
                            if len(raw) != expected:
                                raise ParseError(
                                    f"Decoded cel size mismatch at frame {frame_i} layer {layer_index} (got {len(raw)}, expected {expected})."
                                )
                            bounds = _infer_bounds_from_pixels(
                                raw,
                                int(w),
                                int(h),
                                int(color_depth),
                                int(transparent_index),
                                treat_index0_transparent=treat_index0_transparent,
                            )
                            cel["decodedBounds"] = bounds
                            decoded_cel_bounds[(frame_i, int(layer_index))] = bounds
                            decoded_cel_dims[(frame_i, int(layer_index))] = (int(w), int(h))
                    elif cel_type == 3:  # compressed tilemap
                        w_tiles = r.u16()
                        h_tiles = r.u16()
                        bits_per_tile = r.u16()
                        id_mask = r.u32()
                        xflip_mask = r.u32()
                        yflip_mask = r.u32()
                        dflip_mask = r.u32()
                        r.take(10)
                        compressed = r.take(r.remaining())
                        cel.update(
                            {
                                "wTiles": int(w_tiles),
                                "hTiles": int(h_tiles),
                                "bitsPerTile": int(bits_per_tile),
                                "idMask": int(id_mask),
                                "xFlipMask": int(xflip_mask),
                                "yFlipMask": int(yflip_mask),
                                "dFlipMask": int(dflip_mask),
                                "compressedBytes": len(compressed),
                            }
                        )
                        if decode_cels:
                            tile_bytes = int(bits_per_tile) // 8
                            expected = int(w_tiles) * int(h_tiles) * tile_bytes
                            limit = min(max_decompress_mib * 1024 * 1024, max(expected, 1))
                            raw = _decompress_limited(compressed, limit_bytes=limit)
                            if len(raw) != expected:
                                raise ParseError(
                                    f"Decoded tilemap size mismatch at frame {frame_i} layer {layer_index} (got {len(raw)}, expected {expected})."
                                )
                            # Provide a light summary instead of dumping full raw stream.
                            # Interpret tiles as little-endian integers of size tile_bytes.
                            unique_ids = set()
                            flipped = 0
                            for t_i in range(0, len(raw), tile_bytes):
                                tile_val = int.from_bytes(raw[t_i : t_i + tile_bytes], "little", signed=False)
                                tile_id = tile_val & int(id_mask)
                                if tile_id != 0:
                                    unique_ids.add(tile_id)
                                if tile_val & (int(xflip_mask) | int(yflip_mask) | int(dflip_mask)):
                                    flipped += 1
                            cel["decodedTilemapSummary"] = {
                                "nonZeroUniqueTileIds": len(unique_ids),
                                "flippedTiles": int(flipped),
                            }
                    else:
                        cel["unparsedBytes"] = int(r.remaining())

                    frame_out["chunks"].append({"type": "cel", "data": cel})
                    # Track last cel index for user data attachment.
                    last_object_ref = ("cel", len(frame_out["chunks"]) - 1)
                    cel_index_by_frame_layer[(frame_i, int(layer_index))] = len(frame_out["chunks"]) - 1
                    chunk_summary["parsed"] = {"layerIndex": int(layer_index), "celType": int(cel_type)}

                elif chunk_type == 0x2006:  # Cel extra
                    flags_ex = r.u32()
                    px = r.fixed_16_16()
                    py = r.fixed_16_16()
                    pw = r.fixed_16_16()
                    ph = r.fixed_16_16()
                    r.take(min(16, r.remaining()))
                    frame_out["chunks"].append(
                        {"type": "celExtra", "data": {"flags": int(flags_ex), "precise": {"x": px, "y": py, "w": pw, "h": ph}}}
                    )
                    last_object_ref = ("celExtra", len(frame_out["chunks"]) - 1)
                    chunk_summary["parsed"] = {"flags": int(flags_ex)}

                elif chunk_type == 0x2007:  # Color profile
                    profile_type = r.u16()
                    profile_flags = r.u16()
                    gamma = r.fixed_16_16()
                    r.take(8)
                    icc_len = 0
                    if profile_type == 2:
                        icc_len = r.u32()
                        r.take(min(int(icc_len), r.remaining()))
                    color_profile = {"type": int(profile_type), "flags": int(profile_flags), "gamma": gamma, "iccBytes": int(icc_len)}
                    chunk_summary["parsed"] = {"type": int(profile_type)}

                elif chunk_type == 0x2008:  # External files
                    n = r.u32()
                    r.take(8)
                    entries = []
                    for _ in range(int(n)):
                        entry_id = r.u32()
                        t = r.u8()
                        r.take(7)
                        name = r.string()
                        entries.append({"id": int(entry_id), "type": int(t), "name": name})
                    external_files.extend(entries)
                    chunk_summary["parsed"] = {"entries": int(n)}

                elif chunk_type == 0x2018:  # Tags
                    n = r.u16()
                    r.take(8)
                    tag_list = []
                    for _ in range(int(n)):
                        frm = r.u16()
                        to = r.u16()
                        direction = r.u8()
                        repeat = r.u16()
                        r.take(6)
                        r.take(3)
                        r.take(1)
                        name = r.string()
                        tag_list.append(
                            {"from": int(frm), "to": int(to), "direction": int(direction), "repeat": int(repeat), "name": name}
                        )
                    base_index = len(tags)
                    tags.extend(tag_list)
                    pending_tag_user_data = list(range(base_index, base_index + len(tag_list)))
                    chunk_summary["parsed"] = {"tags": int(n)}

                elif chunk_type == 0x2019:  # Palette
                    new_size = r.u32()
                    first = r.u32()
                    last = r.u32()
                    r.take(8)
                    count = int(last - first + 1) if last >= first else 0
                    entries_preview = []
                    for i in range(count):
                        entry_flags = r.u16()
                        rgba = list(r.take(4))
                        name = None
                        if entry_flags & 1:
                            name = r.string()
                        if i < palette_entries:
                            e: Dict[str, Any] = {"rgba": rgba}
                            if name is not None:
                                e["name"] = name
                            entries_preview.append(e)
                        else:
                            # still must consume name if present (already done)
                            pass
                    palettes.append(
                        {
                            "paletteSize": int(new_size),
                            "first": int(first),
                            "last": int(last),
                            "entriesPreview": entries_preview,
                            "entriesPreviewCount": len(entries_preview),
                            "changedCount": int(count),
                        }
                    )
                    chunk_summary["parsed"] = {"changedCount": int(count)}

                elif chunk_type == 0x2020:  # User data
                    uflags = r.u32()
                    ud: Dict[str, Any] = {"flags": int(uflags)}
                    if uflags & 1:
                        ud["text"] = r.string()
                    if uflags & 2:
                        ud["color"] = list(r.take(4))
                    if uflags & 4:
                        # Size includes this field and map count field. We parse best-effort.
                        total_size = r.u32()
                        maps = r.u32()
                        props_maps = []
                        for _ in range(int(maps)):
                            key = r.u32()
                            props = _parse_properties_map(r)
                            props_maps.append({"key": int(key), "properties": props})
                        ud["properties"] = {"declaredBytes": int(total_size), "maps": props_maps}

                    # Attach to last object, with special handling for tags.
                    attached = {"kind": None, "index": None}
                    if pending_tag_user_data:
                        tag_i = pending_tag_user_data.pop(0)
                        tags[tag_i]["userData"] = ud
                        attached = {"kind": "tag", "index": int(tag_i)}
                    elif last_object_ref is not None:
                        kind, idx = last_object_ref
                        if kind == "layer":
                            layers[idx]["userData"] = ud
                        else:
                            frame_out["chunks"][idx]["userData"] = ud
                        attached = {"kind": kind, "index": int(idx)}
                    chunk_summary["parsed"] = {"attachedTo": attached}

                elif chunk_type == 0x2022:  # Slice
                    n = r.u32()
                    sflags = r.u32()
                    _ = r.u32()
                    name = r.string()
                    keys = []
                    for _ in range(int(n)):
                        frame_number = r.u32()
                        sx = r.s32()
                        sy = r.s32()
                        sw = r.u32()
                        sh = r.u32()
                        key: Dict[str, Any] = {"frame": int(frame_number), "bounds": {"x": int(sx), "y": int(sy), "w": int(sw), "h": int(sh)}}
                        if sflags & 1:
                            cx = r.s32()
                            cy = r.s32()
                            cw = r.u32()
                            ch = r.u32()
                            key["center"] = {"x": int(cx), "y": int(cy), "w": int(cw), "h": int(ch)}
                        if sflags & 2:
                            px = r.s32()
                            py = r.s32()
                            key["pivot"] = {"x": int(px), "y": int(py)}
                        keys.append(key)
                    slices.append({"name": name, "flags": int(sflags), "keys": keys})
                    chunk_summary["parsed"] = {"name": name, "keys": int(n)}

                elif chunk_type == 0x2023:  # Tileset
                    ts_id = r.u32()
                    ts_flags = r.u32()
                    num_tiles = r.u32()
                    tile_w = r.u16()
                    tile_h = r.u16()
                    base_index = r.s16()
                    r.take(14)
                    name = r.string()
                    ts: Dict[str, Any] = {
                        "id": int(ts_id),
                        "flags": int(ts_flags),
                        "numTiles": int(num_tiles),
                        "tileW": int(tile_w),
                        "tileH": int(tile_h),
                        "baseIndex": int(base_index),
                        "name": name,
                    }
                    if ts_flags & 1:
                        ts["external"] = {"fileId": int(r.u32()), "tilesetId": int(r.u32())}
                    if ts_flags & 2:
                        data_len = r.u32()
                        # Skip compressed image bytes.
                        r.take(min(int(data_len), r.remaining()))
                        ts["embeddedImageCompressedBytes"] = int(data_len)
                    tilesets.append(ts)
                    last_object_ref = ("tileset", len(tilesets) - 1)
                    chunk_summary["parsed"] = {"id": int(ts_id), "name": name}

                else:
                    # Unknown/unhandled chunk: store minimal info.
                    unknown_chunks.append({"type": int(chunk_type), "size": int(chunk_size)})

                frame_out.get("chunkSummaries", [])
                frame_out.setdefault("chunkSummaries", []).append(chunk_summary)

            frames_out.append(frame_out)

        # Post-pass: compute effective timeline.
        durations = []
        for fr in frames_out:
            d = int(fr["durationMs"])
            if d <= 0:
                d = int(speed_deprecated)
            durations.append(d)
        total_ms = int(sum(durations))

        # Post-pass: for linked cels, reuse decoded bounds/dims from target frame when possible.
        if decode_cels:
            for frame_i, fr in enumerate(frames_out):
                for chunk in fr["chunks"]:
                    if chunk.get("type") != "cel":
                        continue
                    cel = chunk["data"]
                    if cel.get("celType") != 1:
                        continue
                    target_frame = int(cel.get("linkFrame", -1))
                    layer_index = int(cel.get("layerIndex"))
                    key = (target_frame, layer_index)
                    if key in decoded_cel_bounds:
                        cel["decodedBounds"] = decoded_cel_bounds[key]
                        if key in decoded_cel_dims:
                            w, h = decoded_cel_dims[key]
                            cel["w"] = w
                            cel["h"] = h

        return {
            "path": path,
            "header": header_info,
            "timeline": {"frameMs": durations, "totalMs": total_ms},
            "layers": layers,
            "tags": tags,
            "slices": slices,
            "tilesets": tilesets,
            "externalFiles": external_files,
            "palettes": palettes,
            "colorProfile": color_profile,
            "frames": frames_out,
            "unknownChunks": unknown_chunks,
            "notes": {
                "specExtensions": [".ase", ".aseprite"],
                "commonTypos": [".aes", ".aesprite"],
                "decodeCels": bool(decode_cels),
                "indexedTransparency": {"transparentIndex": int(transparent_index), "treatIndex0Transparent": bool(treat_index0_transparent)},
            },
        }


def main(argv: List[str]) -> int:
    p = argparse.ArgumentParser(description="Inspect an Aseprite .ase/.aseprite file and emit JSON.")
    p.add_argument("file", help="Path to .ase/.aseprite (sometimes typo .aes).")
    p.add_argument("--json", action="store_true", help="Emit JSON to stdout (default).")
    p.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    p.add_argument("--decode-cels", action="store_true", help="Zlib-decompress cel/tilemap data for extra inference (bounds/summaries).")
    p.add_argument("--max-decompress-mib", type=int, default=64, help="Safety limit for decompressed bytes (MiB).")
    p.add_argument("--palette-entries", type=int, default=16, help="How many palette entries to include per palette chunk preview.")
    p.add_argument(
        "--treat-index0-transparent",
        action="store_true",
        help="For indexed sprites, also treat palette index 0 as transparent when inferring bounds (heuristic; off by default).",
    )
    args = p.parse_args(argv)

    out = inspect(
        args.file,
        decode_cels=bool(args.decode_cels),
        max_decompress_mib=int(args.max_decompress_mib),
        palette_entries=int(args.palette_entries),
        treat_index0_transparent=bool(args.treat_index0_transparent),
    )
    if args.pretty:
        print(json.dumps(out, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

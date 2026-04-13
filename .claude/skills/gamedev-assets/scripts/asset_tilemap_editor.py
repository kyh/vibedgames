# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Interactive tileset + tilemap editor for debugging tileset grid assumptions.

The tool is intentionally manifest-driven and only assumes an assets_index.json
exists with a `tilesets` section.

Examples:
  uv run .claude/skills/gamedev-assets/scripts/asset_tilemap_editor.py \\
    --manifest path/to/assets_index.json

  uv run .claude/skills/gamedev-assets/scripts/asset_tilemap_editor.py \\
    --manifest path/to/assets_index.json --map maps/level1.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image
from PIL import ImageDraw, ImageFont

# GUI deps are imported lazily so `--help` works even on systems without tkinter.
tk: Any = None
ttk: Any = None
filedialog: Any = None
messagebox: Any = None
ImageTk: Any = None


def _load_gui_deps() -> None:
    global tk, ttk, filedialog, messagebox, ImageTk  # noqa: PLW0603
    try:
        import tkinter as _tk  # noqa: PLC0415
        from tkinter import filedialog as _filedialog  # noqa: PLC0415
        from tkinter import messagebox as _messagebox  # noqa: PLC0415
        from tkinter import ttk as _ttk  # noqa: PLC0415

        from PIL import ImageTk as _ImageTk  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            "This tool requires tkinter. On macOS, install Python from python.org (includes tkinter), "
            "or ensure your Python distribution includes Tk."
        ) from exc

    tk = _tk
    ttk = _ttk
    filedialog = _filedialog
    messagebox = _messagebox
    ImageTk = _ImageTk


def _sanitize_tilesets(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    tilesets = manifest.get("tilesets")
    if not isinstance(tilesets, dict):
        raise SystemExit("Manifest missing `tilesets` object.")
    out: dict[str, dict[str, Any]] = {}
    for name, ts in tilesets.items():
        if not isinstance(ts, dict):
            continue
        if not isinstance(ts.get("path"), str):
            continue
        out[str(name)] = ts
    if not out:
        raise SystemExit("Manifest has no usable tilesets (each needs a string `path`).")
    return out


def _resolve_asset_path(manifest_path: Path, manifest: dict[str, Any], rel: str) -> Path:
    manifest_dir = manifest_path.parent.resolve()
    meta = manifest.get("meta")
    root = meta.get("root") if isinstance(meta, dict) else None
    base = (manifest_dir / root).resolve() if isinstance(root, str) else manifest_dir

    p = Path(rel)
    if p.is_absolute():
        return p.resolve()

    candidates = [
        (base / p).resolve(),
        (manifest_dir / p).resolve(),
        (Path.cwd() / p).resolve(),
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


def _int(v: Any, default: int) -> int:
    if isinstance(v, (int, float)):
        return int(v)
    return default


@dataclass(frozen=True)
class TilesetMeta:
    name: str
    path: Path
    tile_w: int
    tile_h: int
    columns: int
    rows: int
    margin: int
    spacing: int
    image_w: int
    image_h: int

    @property
    def tile_count(self) -> int:
        return self.columns * self.rows

    def tile_id_from_col_row(self, col0: int, row0: int) -> int:
        if col0 < 0 or row0 < 0 or col0 >= self.columns or row0 >= self.rows:
            return 0
        return row0 * self.columns + col0 + 1

    def col_row_from_tile_id(self, tile_id: int) -> tuple[int, int]:
        if tile_id <= 0:
            return 0, 0
        idx0 = tile_id - 1
        row0 = idx0 // self.columns
        col0 = idx0 - row0 * self.columns
        return col0, row0

    def crop_box(self, tile_id: int) -> tuple[int, int, int, int]:
        col0, row0 = self.col_row_from_tile_id(tile_id)
        x = self.margin + col0 * (self.tile_w + self.spacing)
        y = self.margin + row0 * (self.tile_h + self.spacing)
        return (x, y, x + self.tile_w, y + self.tile_h)


class TilesetCache:
    def __init__(self, meta: TilesetMeta) -> None:
        self.meta = meta
        self.image = Image.open(meta.path).convert("RGBA")
        self._sheet_photo_cache: dict[int, Any] = {}
        self._tile_photo_cache: dict[tuple[int, int], Any] = {}

    def sheet_photo(self, scale: int) -> Any:
        if scale <= 0:
            scale = 1
        cached = self._sheet_photo_cache.get(scale)
        if cached is not None:
            return cached
        img = self.image
        if scale != 1:
            img = img.resize((img.width * scale, img.height * scale), resample=Image.Resampling.NEAREST)
        photo = ImageTk.PhotoImage(img)
        self._sheet_photo_cache[scale] = photo
        return photo

    def tile_photo(self, tile_id: int, scale: int) -> Any | None:
        if tile_id <= 0:
            return None
        scale = max(1, int(scale))
        key = (tile_id, scale)
        cached = self._tile_photo_cache.get(key)
        if cached is not None:
            return cached

        box = self.meta.crop_box(tile_id)
        tile = self.image.crop(box)
        if scale != 1:
            tile = tile.resize((self.meta.tile_w * scale, self.meta.tile_h * scale), resample=Image.Resampling.NEAREST)
        photo = ImageTk.PhotoImage(tile)
        self._tile_photo_cache[key] = photo
        return photo


def _new_map(w: int, h: int) -> list[list[int]]:
    return [[0 for _ in range(w)] for _ in range(h)]


def _normalize_map_data(data: Any, w: int, h: int) -> list[list[int]]:
    out = _new_map(w, h)
    if not isinstance(data, list):
        return out
    for y in range(min(h, len(data))):
        row = data[y]
        if not isinstance(row, list):
            continue
        for x in range(min(w, len(row))):
            v = row[x]
            if isinstance(v, (int, float)):
                out[y][x] = int(v)
    return out


def _load_manifest_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit("Manifest JSON must be an object at top-level.")
    return payload


def _tileset_meta_from_manifest(manifest_path: Path, manifest: dict[str, Any], name: str) -> TilesetMeta:
    tilesets = _sanitize_tilesets(manifest)
    if name not in tilesets:
        raise SystemExit(f"Tileset not found in manifest: {name}")
    ts = tilesets[name]

    rel = str(ts["path"])
    path = _resolve_asset_path(manifest_path, manifest, rel)
    if not path.exists():
        raise SystemExit(f"Tileset file not found: {path}")

    tile_w = _int(ts.get("tileWidth") or ts.get("tileW"), 16)
    tile_h = _int(ts.get("tileHeight") or ts.get("tileH"), 16)
    margin = _int(ts.get("margin"), 0)
    spacing = _int(ts.get("spacing"), 0)

    with Image.open(path) as img:
        img_w, img_h = img.size

    columns = _int(ts.get("columns"), 0)
    rows = _int(ts.get("rows"), 0)
    if columns <= 0:
        denom = tile_w + spacing
        columns = (img_w - 2 * margin + spacing) // denom if denom > 0 else 0
    if rows <= 0:
        denom = tile_h + spacing
        rows = (img_h - 2 * margin + spacing) // denom if denom > 0 else 0

    if columns <= 0 or rows <= 0:
        raise SystemExit(f"Invalid tileset grid for {name}: columns={columns} rows={rows}")

    return TilesetMeta(
        name=name,
        path=path,
        tile_w=tile_w,
        tile_h=tile_h,
        columns=columns,
        rows=rows,
        margin=margin,
        spacing=spacing,
        image_w=img_w,
        image_h=img_h,
    )


def _export_tileset_grid(meta: TilesetMeta, out_path: Path, *, scale: int, label_ids: bool, trim: bool = False) -> None:
    scale = max(1, int(scale))
    with Image.open(meta.path) as img:
        img = img.convert("RGBA")

    if scale != 1:
        img = img.resize((img.width * scale, img.height * scale), resample=Image.Resampling.NEAREST)

    draw = ImageDraw.Draw(img)
    line = (255, 255, 255, 80)
    bold = (47, 230, 255, 180)
    x0 = meta.margin * scale
    y0 = meta.margin * scale
    step_x = (meta.tile_w + meta.spacing) * scale
    step_y = (meta.tile_h + meta.spacing) * scale
    w = meta.columns * meta.tile_w * scale + max(0, (meta.columns - 1) * meta.spacing * scale)
    h = meta.rows * meta.tile_h * scale + max(0, (meta.rows - 1) * meta.spacing * scale)

    for c in range(meta.columns + 1):
        x = x0 + c * step_x
        draw.line([(x, y0), (x, y0 + h)], fill=line, width=1)
    for r in range(meta.rows + 1):
        y = y0 + r * step_y
        draw.line([(x0, y), (x0 + w, y)], fill=line, width=1)

    draw.rectangle([x0, y0, x0 + w, y0 + h], outline=bold, width=2)

    if label_ids:
        font = ImageFont.load_default()
        for r in range(meta.rows):
            for c in range(meta.columns):
                tid = meta.tile_id_from_col_row(c, r)
                tx = x0 + c * step_x + 2
                ty = y0 + r * step_y + 2
                draw.text((tx + 1, ty + 1), str(tid), fill=(0, 0, 0, 180), font=font)
                draw.text((tx, ty), str(tid), fill=(255, 255, 255, 200), font=font)

    if trim:
        img = _trim_transparent(img)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)


def _trim_transparent(img: Image.Image) -> Image.Image:
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    bbox = img.getchannel("A").getbbox()
    if bbox is None:
        return img
    return img.crop(bbox)


def _export_map_render(
    meta: TilesetMeta,
    out_path: Path,
    *,
    map_payload: dict[str, Any],
    scale: int,
    bg_rgba: tuple[int, int, int, int] | None = None,
    fills: list[tuple[int, int, int, int, tuple[int, int, int, int]]] | None = None,
    trim: bool = False,
) -> None:
    scale = max(1, int(scale))
    data = map_payload.get("data")
    if not isinstance(data, list):
        raise SystemExit("Map JSON must have `data` as a 2D array.")

    map_meta = map_payload.get("meta")
    w = _int(map_meta.get("width"), 0) if isinstance(map_meta, dict) else 0
    h = _int(map_meta.get("height"), 0) if isinstance(map_meta, dict) else 0
    if w <= 0:
        w = max((len(row) for row in data if isinstance(row, list)), default=0)
    if h <= 0:
        h = len(data)
    if w <= 0 or h <= 0:
        raise SystemExit("Invalid map dimensions.")

    grid = _normalize_map_data(data, w, h)

    with Image.open(meta.path) as sheet:
        sheet = sheet.convert("RGBA")

        out = Image.new("RGBA", (w * meta.tile_w, h * meta.tile_h), bg_rgba or (0, 0, 0, 0))
        if fills:
            draw = ImageDraw.Draw(out)
            for fx, fy, fw, fh, color in fills:
                x1 = fx * meta.tile_w
                y1 = fy * meta.tile_h
                x2 = (fx + fw) * meta.tile_w
                y2 = (fy + fh) * meta.tile_h
                draw.rectangle([x1, y1, x2, y2], fill=color)

        for y in range(h):
            for x in range(w):
                tid = int(grid[y][x])
                if tid <= 0:
                    continue
                box = meta.crop_box(tid)
                tile = sheet.crop(box)
                out.alpha_composite(tile, dest=(x * meta.tile_w, y * meta.tile_h))

    if scale != 1:
        out = out.resize((out.width * scale, out.height * scale), resample=Image.Resampling.NEAREST)
    if trim:
        out = _trim_transparent(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.save(out_path)


def _tileset_non_empty_tile_ids(meta: TilesetMeta) -> set[int]:
    with Image.open(meta.path) as img:
        img = img.convert("RGBA")
        alpha = img.getchannel("A")

        non_empty: set[int] = set()
        for tid in range(1, meta.tile_count + 1):
            box = meta.crop_box(tid)
            cell = alpha.crop(box)
            if cell.getbbox() is not None:
                non_empty.add(tid)
        return non_empty


def _make_tileset_selftest_map(meta: TilesetMeta, out_path: Path) -> None:
    non_empty = _tileset_non_empty_tile_ids(meta)
    data: list[list[int]] = []
    for r in range(meta.rows):
        row: list[int] = []
        for c in range(meta.columns):
            tid = meta.tile_id_from_col_row(c, r)
            row.append(tid if tid in non_empty else 0)
        data.append(row)

    payload = {
        "meta": {
            "version": 1,
            "tileset": meta.name,
            "tileWidth": meta.tile_w,
            "tileHeight": meta.tile_h,
            "width": meta.columns,
            "height": meta.rows,
            "generatedFrom": meta.path.as_posix(),
            "generator": "asset_tilemap_editor.py --make-selftest-map",
        },
        "data": data,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


class EditorApp:
    def __init__(self, root: Any, manifest_path: Path, map_path: Path | None) -> None:
        self.root = root
        self.manifest_path = manifest_path
        self.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(self.manifest, dict):
            raise SystemExit("Manifest JSON must be an object at top-level.")

        self.tilesets = _sanitize_tilesets(self.manifest)
        self.tileset_names = sorted(self.tilesets.keys())
        self.tileset_index = 0
        self.tileset_meta: TilesetMeta | None = None
        self.tileset_cache: TilesetCache | None = None

        self.palette_col0 = 0
        self.palette_row0 = 0
        self.cursor_x = 0
        self.cursor_y = 0

        self.map_w = 64
        self.map_h = 36
        self.map_data = _new_map(self.map_w, self.map_h)
        self.map_path = map_path

        self.grid = True
        self.help = True
        self.palette_scale = 4
        self.map_scale = 3

        self.cam_x = 0
        self.cam_y = 0

        self._status_var = tk.StringVar(value="")
        self._message_var = tk.StringVar(value="")

        self._sheet_photo_ref: Any | None = None
        self._palette_img_id: int | None = None
        self._palette_sel_id: int | None = None
        self._palette_grid_ids: list[int] = []

        self._map_sel_rect_id: int | None = None
        self._map_image_ids: list[int] = []
        self._map_grid_ids: list[int] = []

        self._build_ui()
        self._bind_keys()

        self._load_tileset(self.tileset_names[self.tileset_index])
        if self.map_path and self.map_path.exists():
            self.load_map(self.map_path)
        self._redraw_all()

    def _build_ui(self) -> None:
        self.root.title("Gamedev Assets — Tilemap Editor")
        self.root.geometry("1300x760")

        top = ttk.Frame(self.root, padding=8)
        top.pack(fill="both", expand=True)

        paned = ttk.Panedwindow(top, orient="horizontal")
        paned.pack(fill="both", expand=True)

        left = ttk.Frame(paned, padding=6)
        right = ttk.Frame(paned, padding=6)
        paned.add(left, weight=1)
        paned.add(right, weight=3)

        header = ttk.Frame(left)
        header.pack(fill="x")
        ttk.Label(header, text="Tileset").pack(side="left")
        self._tileset_combo = ttk.Combobox(header, values=self.tileset_names, state="readonly", width=20)
        self._tileset_combo.current(0)
        self._tileset_combo.pack(side="left", padx=(8, 0))
        self._tileset_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_tileset_selected())

        self._palette_canvas = tk.Canvas(left, width=420, height=500, bg="#15171a", highlightthickness=0)
        self._palette_canvas.pack(fill="both", expand=True, pady=(8, 0))
        self._palette_canvas.bind("<Button-1>", self._on_palette_click)

        palette_controls = ttk.Frame(left)
        palette_controls.pack(fill="x", pady=(8, 0))
        ttk.Button(palette_controls, text="Grid", command=self._toggle_grid).pack(side="left")
        ttk.Button(palette_controls, text="Help", command=self._toggle_help).pack(side="left", padx=(8, 0))
        ttk.Button(palette_controls, text="Save", command=self._save_dialog).pack(side="left", padx=(8, 0))
        ttk.Button(palette_controls, text="Load", command=self._load_dialog).pack(side="left", padx=(8, 0))

        map_header = ttk.Frame(right)
        map_header.pack(fill="x")
        ttk.Label(map_header, text="Map").pack(side="left")
        ttk.Label(map_header, textvariable=self._status_var).pack(side="left", padx=(10, 0))

        self._map_canvas = tk.Canvas(right, bg="#0f1114", highlightthickness=0)
        self._map_canvas.pack(fill="both", expand=True, pady=(8, 0))
        self._map_canvas.bind("<Button-1>", self._on_map_left_click)
        self._map_canvas.bind("<Button-3>", self._on_map_right_click)

        self._message = ttk.Label(top, textvariable=self._message_var, foreground="#d0d0d0")
        self._message.pack(fill="x", pady=(8, 0))

    def _bind_keys(self) -> None:
        self.root.bind("<KeyPress>", self._on_key)
        self.root.bind("<F5>", lambda _e: self.quick_save())
        self.root.bind("<F9>", lambda _e: self.quick_load())

        self.root.bind_all("<Control-s>", lambda _e: self.quick_save())
        self.root.bind_all("<Control-o>", lambda _e: self._load_dialog())
        self.root.bind_all("<Control-l>", lambda _e: self.quick_load())

    def _toast(self, msg: str) -> None:
        self._message_var.set(msg)

    def _on_tileset_selected(self) -> None:
        name = self._tileset_combo.get()
        if name:
            self._load_tileset(name)
            self._redraw_all()

    def _toggle_grid(self) -> None:
        self.grid = not self.grid
        self._redraw_all()

    def _toggle_help(self) -> None:
        self.help = not self.help
        self._redraw_all()

    def _load_tileset(self, name: str) -> None:
        ts = self.tilesets[name]
        rel = str(ts["path"])
        path = _resolve_asset_path(self.manifest_path, self.manifest, rel)
        if not path.exists():
            raise SystemExit(f"Tileset file not found: {path}")

        tile_w = _int(ts.get("tileWidth") or ts.get("tileW"), 16)
        tile_h = _int(ts.get("tileHeight") or ts.get("tileH"), 16)
        margin = _int(ts.get("margin"), 0)
        spacing = _int(ts.get("spacing"), 0)

        with Image.open(path) as img:
            img_w, img_h = img.size

        columns = _int(ts.get("columns"), 0)
        rows = _int(ts.get("rows"), 0)
        if columns <= 0:
            denom = tile_w + spacing
            columns = (img_w - 2 * margin + spacing) // denom if denom > 0 else 0
        if rows <= 0:
            denom = tile_h + spacing
            rows = (img_h - 2 * margin + spacing) // denom if denom > 0 else 0

        if columns <= 0 or rows <= 0:
            raise SystemExit(f"Invalid tileset grid for {name}: columns={columns} rows={rows}")

        self.tileset_meta = TilesetMeta(
            name=name,
            path=path,
            tile_w=tile_w,
            tile_h=tile_h,
            columns=columns,
            rows=rows,
            margin=margin,
            spacing=spacing,
            image_w=img_w,
            image_h=img_h,
        )
        self.tileset_cache = TilesetCache(self.tileset_meta)
        self.palette_col0 = min(self.palette_col0, columns - 1)
        self.palette_row0 = min(self.palette_row0, rows - 1)

        self._tileset_combo.set(name)
        self._toast(f"Tileset: {name} ({columns}x{rows})  file={path}")

    def _on_palette_click(self, e: Any) -> None:  # type: ignore[override]
        meta = self.tileset_meta
        if meta is None:
            return
        col0 = int(e.x // (meta.tile_w * self.palette_scale))
        row0 = int(e.y // (meta.tile_h * self.palette_scale))
        if 0 <= col0 < meta.columns and 0 <= row0 < meta.rows:
            self.palette_col0 = col0
            self.palette_row0 = row0
            self._redraw_palette()
            self._redraw_status()

    def _on_map_left_click(self, e: Any) -> None:  # type: ignore[override]
        self._map_click(e.x, e.y, paint=True)

    def _on_map_right_click(self, e: Any) -> None:  # type: ignore[override]
        self._map_click(e.x, e.y, paint=False)

    def _map_click(self, x: int, y: int, *, paint: bool) -> None:
        meta = self.tileset_meta
        if meta is None:
            return

        tile_px = meta.tile_w * self.map_scale
        tile_py = meta.tile_h * self.map_scale

        map_w_px = self._map_canvas.winfo_width()
        map_h_px = self._map_canvas.winfo_height()
        if map_w_px <= 1 or map_h_px <= 1:
            return

        col = int((x + self.cam_x) // tile_px)
        row = int((y + self.cam_y) // tile_py)
        if 0 <= col < self.map_w and 0 <= row < self.map_h:
            self.cursor_x = col
            self.cursor_y = row
            if paint:
                self.paint()
            else:
                self.erase()
            self._redraw_map()
            self._redraw_status()

    def _on_key(self, e: Any) -> None:  # type: ignore[override]
        meta = self.tileset_meta
        if meta is None:
            return

        key = e.keysym.lower()
        if key == "g":
            self.grid = not self.grid
            self._redraw_all()
            return
        if key == "h":
            self.help = not self.help
            self._redraw_all()
            return
        if key in ("equal", "plus"):
            self.map_scale = min(10, self.map_scale + 1)
            self._redraw_all()
            return
        if key in ("minus", "underscore"):
            self.map_scale = max(1, self.map_scale - 1)
            self._redraw_all()
            return
        if key == "bracketleft":
            self._cycle_tileset(-1)
            return
        if key == "bracketright":
            self._cycle_tileset(1)
            return

        if key == "left":
            self.cursor_x = max(0, self.cursor_x - 1)
        elif key == "right":
            self.cursor_x = min(self.map_w - 1, self.cursor_x + 1)
        elif key == "up":
            self.cursor_y = max(0, self.cursor_y - 1)
        elif key == "down":
            self.cursor_y = min(self.map_h - 1, self.cursor_y + 1)
        elif key == "a":
            self.palette_col0 = max(0, self.palette_col0 - 1)
            self._redraw_palette()
        elif key == "d":
            self.palette_col0 = min(meta.columns - 1, self.palette_col0 + 1)
            self._redraw_palette()
        elif key == "w":
            self.palette_row0 = max(0, self.palette_row0 - 1)
            self._redraw_palette()
        elif key == "s":
            self.palette_row0 = min(meta.rows - 1, self.palette_row0 + 1)
            self._redraw_palette()
        elif key in ("space", "return"):
            self.paint()
        elif key in ("backspace", "delete", "x"):
            self.erase()
        elif key == "n":
            self.map_data = _new_map(self.map_w, self.map_h)
            self._toast(f"New map: {self.map_w}x{self.map_h}")
            self._redraw_map()
        else:
            return

        self._ensure_cursor_visible()
        self._redraw_map()
        self._redraw_status()

    def _cycle_tileset(self, delta: int) -> None:
        self.tileset_index = (self.tileset_index + delta) % len(self.tileset_names)
        name = self.tileset_names[self.tileset_index]
        self._load_tileset(name)
        self._redraw_all()

    def selected_tile_id(self) -> int:
        meta = self.tileset_meta
        if meta is None:
            return 0
        return meta.tile_id_from_col_row(self.palette_col0, self.palette_row0)

    def paint(self) -> None:
        tid = self.selected_tile_id()
        self.map_data[self.cursor_y][self.cursor_x] = tid

    def erase(self) -> None:
        self.map_data[self.cursor_y][self.cursor_x] = 0

    def _ensure_cursor_visible(self) -> None:
        meta = self.tileset_meta
        if meta is None:
            return
        tile_px = meta.tile_w * self.map_scale
        tile_py = meta.tile_h * self.map_scale

        view_w = max(1, self._map_canvas.winfo_width())
        view_h = max(1, self._map_canvas.winfo_height())
        map_w_px = self.map_w * tile_px
        map_h_px = self.map_h * tile_py

        cx = self.cursor_x * tile_px + tile_px // 2
        cy = self.cursor_y * tile_py + tile_py // 2
        target_x = cx - view_w // 2
        target_y = cy - view_h // 2
        self.cam_x = max(0, min(target_x, max(0, map_w_px - view_w)))
        self.cam_y = max(0, min(target_y, max(0, map_h_px - view_h)))

    def _redraw_status(self) -> None:
        meta = self.tileset_meta
        if meta is None:
            return
        sel = self.selected_tile_id()
        under = self.map_data[self.cursor_y][self.cursor_x]
        uc0, ur0 = meta.col_row_from_tile_id(under)
        path_str = str(self.map_path) if self.map_path else "(unsaved)"
        self._status_var.set(
            f"{meta.name}  map={self.map_w}x{self.map_h}  cursor=({self.cursor_x+1},{self.cursor_y+1})"
            f"  tile={under} (col={uc0} row={ur0})  sel={sel}  file={path_str}"
        )

    def _redraw_palette(self) -> None:
        meta = self.tileset_meta
        cache = self.tileset_cache
        if meta is None or cache is None:
            return

        sheet = cache.sheet_photo(self.palette_scale)
        self._sheet_photo_ref = sheet

        self._palette_canvas.delete("all")
        self._palette_img_id = self._palette_canvas.create_image(0, 0, anchor="nw", image=sheet)

        if self.grid:
            for c in range(meta.columns + 1):
                x = c * meta.tile_w * self.palette_scale
                self._palette_grid_ids.append(
                    self._palette_canvas.create_line(
                        x,
                        0,
                        x,
                        meta.rows * meta.tile_h * self.palette_scale,
                        fill="#ffffff",
                        stipple="gray25",
                    )
                )
            for r in range(meta.rows + 1):
                y = r * meta.tile_h * self.palette_scale
                self._palette_grid_ids.append(
                    self._palette_canvas.create_line(
                        0,
                        y,
                        meta.columns * meta.tile_w * self.palette_scale,
                        y,
                        fill="#ffffff",
                        stipple="gray25",
                    )
                )

        sel_x1 = self.palette_col0 * meta.tile_w * self.palette_scale
        sel_y1 = self.palette_row0 * meta.tile_h * self.palette_scale
        sel_x2 = sel_x1 + meta.tile_w * self.palette_scale
        sel_y2 = sel_y1 + meta.tile_h * self.palette_scale
        self._palette_sel_id = self._palette_canvas.create_rectangle(
            sel_x1, sel_y1, sel_x2, sel_y2, outline="#2fe6ff", width=2
        )

        self._palette_canvas.config(scrollregion=(0, 0, sheet.width(), sheet.height()))

    def _redraw_map(self) -> None:
        meta = self.tileset_meta
        cache = self.tileset_cache
        if meta is None or cache is None:
            return

        self._map_canvas.delete("all")
        self._map_image_ids.clear()
        self._map_grid_ids.clear()

        tile_px = meta.tile_w * self.map_scale
        tile_py = meta.tile_h * self.map_scale

        view_w = max(1, self._map_canvas.winfo_width())
        view_h = max(1, self._map_canvas.winfo_height())

        start_c = int(self.cam_x // tile_px)
        start_r = int(self.cam_y // tile_py)
        end_c = min(self.map_w, start_c + int(math.ceil(view_w / tile_px)) + 2)
        end_r = min(self.map_h, start_r + int(math.ceil(view_h / tile_py)) + 2)

        for r in range(start_r, end_r):
            py = r * tile_py - self.cam_y
            row = self.map_data[r]
            for c in range(start_c, end_c):
                tid = row[c]
                if tid <= 0:
                    continue
                photo = cache.tile_photo(tid, self.map_scale)
                if photo is None:
                    continue
                px = c * tile_px - self.cam_x
                self._map_image_ids.append(self._map_canvas.create_image(px, py, anchor="nw", image=photo))

        if self.grid:
            for c in range(start_c, end_c + 1):
                x = c * tile_px - self.cam_x
                self._map_grid_ids.append(
                    self._map_canvas.create_line(x, 0, x, view_h, fill="#ffffff", stipple="gray25")
                )
            for r in range(start_r, end_r + 1):
                y = r * tile_py - self.cam_y
                self._map_grid_ids.append(
                    self._map_canvas.create_line(0, y, view_w, y, fill="#ffffff", stipple="gray25")
                )

        cx1 = self.cursor_x * tile_px - self.cam_x
        cy1 = self.cursor_y * tile_py - self.cam_y
        cx2 = cx1 + tile_px
        cy2 = cy1 + tile_py
        self._map_sel_rect_id = self._map_canvas.create_rectangle(
            cx1, cy1, cx2, cy2, outline="#ffbf32", width=2
        )

        if self.help:
            self._draw_help()

    def _draw_help(self) -> None:
        lines = [
            "Arrows: move cursor (cell-by-cell)",
            "WASD: move palette selection",
            "Space/Enter: paint   X/Backspace: erase",
            "[ / ]: switch tileset   +/-: zoom map",
            "F5: quick-save   F9: quick-load   N: new map",
            "G: grid   H: toggle help",
            "Mouse: left paint / right erase",
        ]
        x, y = 12, 12
        w = 520
        h = 18 * len(lines) + 12
        self._map_canvas.create_rectangle(x, y, x + w, y + h, fill="#000000", stipple="gray50", outline="")
        for i, line in enumerate(lines):
            self._map_canvas.create_text(
                x + 10, y + 10 + i * 18, anchor="nw", text=line, fill="#e8e8e8", font=("Menlo", 12)
            )

    def _redraw_all(self) -> None:
        self._ensure_cursor_visible()
        self._redraw_palette()
        self._redraw_map()
        self._redraw_status()

    def quick_save(self) -> None:
        path = self.map_path or Path("tilemap.json")
        self.save_map(path)

    def quick_load(self) -> None:
        if not self.map_path:
            self._toast("No --map provided; use Load.")
            return
        if not self.map_path.exists():
            self._toast(f"Map not found: {self.map_path}")
            return
        self.load_map(self.map_path)

    def _save_dialog(self) -> None:
        initial = str(self.map_path) if self.map_path else "tilemap.json"
        path = filedialog.asksaveasfilename(
            title="Save tilemap",
            defaultextension=".json",
            initialfile=Path(initial).name,
            filetypes=[("JSON", "*.json"), ("All files", "*.*")],
        )
        if not path:
            return
        self.save_map(Path(path))

    def _load_dialog(self) -> None:
        path = filedialog.askopenfilename(
            title="Open tilemap",
            filetypes=[("JSON", "*.json"), ("All files", "*.*")],
        )
        if not path:
            return
        self.load_map(Path(path))

    def save_map(self, path: Path) -> None:
        meta = self.tileset_meta
        if meta is None:
            return
        payload = {
            "meta": {
                "version": 1,
                "tileset": meta.name,
                "tileWidth": meta.tile_w,
                "tileHeight": meta.tile_h,
                "width": self.map_w,
                "height": self.map_h,
            },
            "data": self.map_data,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        self.map_path = path
        self._toast(f"Saved map: {path}")
        self._redraw_status()

    def load_map(self, path: Path) -> None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("Load failed", str(exc))
            return
        if not isinstance(payload, dict):
            messagebox.showerror("Load failed", "Map JSON must be an object.")
            return
        meta = payload.get("meta")
        data = payload.get("data")
        if not isinstance(meta, dict) or not isinstance(data, list):
            messagebox.showerror("Load failed", "Map JSON must have `meta` object and `data` array.")
            return
        w = _int(meta.get("width"), self.map_w)
        h = _int(meta.get("height"), self.map_h)
        w = max(1, min(512, w))
        h = max(1, min(512, h))

        self.map_w = w
        self.map_h = h
        self.map_data = _normalize_map_data(data, w, h)
        self.cursor_x = min(self.cursor_x, w - 1)
        self.cursor_y = min(self.cursor_y, h - 1)
        self.map_path = path

        tileset_name = meta.get("tileset")
        if isinstance(tileset_name, str) and tileset_name in self.tilesets:
            self._load_tileset(tileset_name)
            self.tileset_index = self.tileset_names.index(tileset_name)

        self._toast(f"Loaded map: {path}")
        self._redraw_all()


def main() -> None:
    parser = argparse.ArgumentParser(description="Tileset/tilemap editor for assets_index.json.")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Path to assets_index.json (default: auto-detect common names).",
    )
    parser.add_argument("--map", type=Path, default=None, help="Optional tilemap JSON path to load/save.")
    parser.add_argument(
        "--tileset",
        type=str,
        default=None,
        help="Tileset name to use for headless exports (default: first tileset in manifest).",
    )
    parser.add_argument("--export-tileset-grid", type=Path, default=None, help="Export a grid-overlay PNG for the tileset.")
    parser.add_argument("--export-map-render", type=Path, default=None, help="Render `--map` to a PNG using the chosen tileset.")
    parser.add_argument("--make-selftest-map", type=Path, default=None, help="Generate a tilemap JSON showing all non-empty tiles in-place.")
    parser.add_argument("--scale", type=int, default=4, help="Scale factor for PNG exports (default: 4).")
    parser.add_argument("--label-ids", action="store_true", help="Label tile IDs on the exported tileset grid.")
    parser.add_argument(
        "--bg",
        type=str,
        default=None,
        help="Background color for --export-map-render as #RRGGBB or #RRGGBBAA.",
    )
    parser.add_argument(
        "--fill-rect",
        action="append",
        default=None,
        help="Fill a tile-rect behind tiles: x,y,w,h,#RRGGBB[AA] (tile units). Can be repeated.",
    )
    parser.add_argument(
        "--trim",
        action="store_true",
        help="Trim transparent borders on PNG exports (headless export mode only).",
    )
    args = parser.parse_args()

    manifest_candidates = [
        Path("assets_index.json"),
        Path("asset_index.json"),
        Path("assets/assets_index.json"),
        Path("assets/asset_index.json"),
    ]

    def resolve_manifest_path(p: Path | None) -> Path:
        if p is None:
            found = next((c for c in manifest_candidates if c.exists()), None)
            if found is None:
                raise SystemExit(
                    "Manifest not found. Pass --manifest or create one of: "
                    + ", ".join(str(c) for c in manifest_candidates)
                )
            return found

        if p.exists() and p.is_dir():
            dir_candidates = [
                p / "assets_index.json",
                p / "asset_index.json",
            ]
            found = next((c for c in dir_candidates if c.exists()), None)
            if found is None:
                raise SystemExit(
                    f"--manifest points at a directory ({p}), but no assets_index.json was found inside."
                )
            return found

        if not p.exists():
            raise SystemExit(f"Manifest not found: {p}")
        return p

    manifest = resolve_manifest_path(args.manifest)

    # Headless export mode (no tkinter required).
    if args.export_tileset_grid or args.export_map_render or args.make_selftest_map:
        manifest_payload = _load_manifest_json(manifest)
        tilesets = _sanitize_tilesets(manifest_payload)
        tileset_name = args.tileset or sorted(tilesets.keys())[0]
        meta = _tileset_meta_from_manifest(manifest, manifest_payload, tileset_name)

        if args.export_tileset_grid:
            _export_tileset_grid(meta, args.export_tileset_grid, scale=args.scale, label_ids=args.label_ids, trim=args.trim)
            print(f"Wrote {args.export_tileset_grid}")

        if args.export_map_render:
            if not args.map:
                raise SystemExit("--export-map-render requires --map PATH")
            map_payload = json.loads(args.map.read_text(encoding="utf-8"))
            if not isinstance(map_payload, dict):
                raise SystemExit("Map JSON must be an object at top-level.")

            map_meta = map_payload.get("meta")
            if isinstance(map_meta, dict) and isinstance(map_meta.get("tileset"), str):
                ts_name = str(map_meta["tileset"])
                if ts_name in tilesets:
                    meta = _tileset_meta_from_manifest(manifest, manifest_payload, ts_name)
            def parse_hex_color(s: str) -> tuple[int, int, int, int]:
                s = s.strip()
                if s.startswith("#"):
                    s = s[1:]
                if len(s) not in (6, 8):
                    raise SystemExit(f"Invalid color (expected #RRGGBB or #RRGGBBAA): {s!r}")
                r = int(s[0:2], 16)
                g = int(s[2:4], 16)
                b = int(s[4:6], 16)
                a = int(s[6:8], 16) if len(s) == 8 else 255
                return (r, g, b, a)

            bg = parse_hex_color(args.bg) if args.bg else None
            fills: list[tuple[int, int, int, int, tuple[int, int, int, int]]] = []
            if args.fill_rect:
                for spec in args.fill_rect:
                    parts = [p.strip() for p in str(spec).split(",")]
                    if len(parts) != 5:
                        raise SystemExit("--fill-rect must be x,y,w,h,#RRGGBB[AA]")
                    fx, fy, fw, fh = (int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3]))
                    color = parse_hex_color(parts[4])
                    fills.append((fx, fy, fw, fh, color))

            _export_map_render(
                meta,
                args.export_map_render,
                map_payload=map_payload,
                scale=args.scale,
                bg_rgba=bg,
                fills=fills or None,
                trim=args.trim,
            )
            print(f"Wrote {args.export_map_render}")

        if args.make_selftest_map:
            _make_tileset_selftest_map(meta, args.make_selftest_map)
            print(f"Wrote {args.make_selftest_map}")
        return

    _load_gui_deps()
    root = tk.Tk()
    try:
        EditorApp(root, manifest, args.map)
        root.mainloop()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        raise


if __name__ == "__main__":
    main()

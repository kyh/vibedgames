from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
RASTER_EXTENSIONS = IMAGE_EXTENSIONS - {".gif"}


def natural_key(path: Path) -> list[object]:
    parts = re.split(r"(\d+)", path.name)
    key: list[object] = []
    for part in parts:
        key.append(int(part) if part.isdigit() else part.lower())
    return key


def image_paths(source_dir: Path, extensions: Iterable[str] = IMAGE_EXTENSIONS) -> list[Path]:
    allowed = {extension.lower() for extension in extensions}
    return sorted(
        [path for path in source_dir.iterdir() if path.suffix.lower() in allowed],
        key=natural_key,
    )

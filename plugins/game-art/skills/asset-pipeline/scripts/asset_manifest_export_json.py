# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Export a Lua asset manifest (assets_index.lua) to a portable assets_index.json.

This is intentionally dependency-free so the skill can be used in any project
without requiring Lua or extra Python packages.

Examples:
  uv run .claude/skills/gamedev-assets/scripts/asset_manifest_export_json.py \\
    --manifest path/to/assets_index.lua \\
    --out path/to/assets_index.json
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator


class LuaParseError(ValueError):
    pass


_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


@dataclass(frozen=True)
class Tok:
    t: str
    v: str
    pos: int


class Lexer:
    def __init__(self, text: str) -> None:
        self.text = text
        self.i = 0

    def _peek(self, n: int = 0) -> str:
        j = self.i + n
        if j >= len(self.text):
            return ""
        return self.text[j]

    def _eat(self, n: int = 1) -> str:
        s = self.text[self.i : self.i + n]
        self.i += n
        return s

    def _skip_ws_and_comments(self) -> None:
        while True:
            while self._peek() and self._peek().isspace():
                self.i += 1

            if self._peek() == "-" and self._peek(1) == "-":
                self._eat(2)
                if self._peek() == "[" and self._peek(1) == "[":
                    self._eat(2)
                    end = self.text.find("]]", self.i)
                    if end == -1:
                        self.i = len(self.text)
                        return
                    self.i = end + 2
                else:
                    while self._peek() and self._peek() != "\n":
                        self.i += 1
                continue

            return

    def tokens(self) -> Iterator[Tok]:
        while True:
            self._skip_ws_and_comments()
            if self.i >= len(self.text):
                yield Tok("eof", "", self.i)
                return

            ch = self._peek()
            pos = self.i

            if ch in "{}[]=,;":
                yield Tok(ch, ch, pos)
                self.i += 1
                continue

            if ch in ("'", '"'):
                quote = ch
                self.i += 1
                out: list[str] = []
                while True:
                    c = self._peek()
                    if c == "":
                        raise LuaParseError("Unterminated string")
                    if c == quote:
                        self.i += 1
                        break
                    if c == "\\":
                        self.i += 1
                        esc = self._peek()
                        if esc == "n":
                            out.append("\n")
                            self.i += 1
                        elif esc == "t":
                            out.append("\t")
                            self.i += 1
                        elif esc == "r":
                            out.append("\r")
                            self.i += 1
                        elif esc in ('"', "'", "\\"):
                            out.append(esc)
                            self.i += 1
                        else:
                            out.append("\\" + esc)
                            if esc:
                                self.i += 1
                        continue
                    out.append(c)
                    self.i += 1
                yield Tok("string", "".join(out), pos)
                continue

            if ch.isdigit() or (ch == "-" and self._peek(1).isdigit()):
                j = self.i
                if ch == "-":
                    j += 1
                while j < len(self.text) and (self.text[j].isdigit() or self.text[j] == "."):
                    j += 1
                s = self.text[self.i : j]
                self.i = j
                yield Tok("number", s, pos)
                continue

            m = _IDENT_RE.match(self.text, self.i)
            if m:
                s = m.group(0)
                self.i = m.end()
                yield Tok("ident", s, pos)
                continue

            raise LuaParseError(f"Unexpected character at {pos}: {ch!r}")


class Parser:
    def __init__(self, text: str) -> None:
        self._tokens = list(Lexer(text).tokens())
        self._k = 0

    def _cur(self) -> Tok:
        return self._tokens[self._k]

    def _peek(self, n: int = 1) -> Tok:
        j = self._k + n
        if j >= len(self._tokens):
            return self._tokens[-1]
        return self._tokens[j]

    def _eat(self, t: str | None = None) -> Tok:
        tok = self._cur()
        if t is not None and tok.t != t:
            raise LuaParseError(f"Expected {t}, got {tok.t} at {tok.pos}")
        self._k += 1
        return tok

    def parse(self) -> Any:
        if self._cur().t == "ident" and self._cur().v == "return":
            self._eat("ident")
        value = self._parse_value()
        if self._cur().t != "eof":
            raise LuaParseError(f"Trailing tokens at {self._cur().pos}")
        return value

    def _parse_value(self) -> Any:
        tok = self._cur()
        if tok.t == "{":
            return self._parse_table()
        if tok.t == "string":
            self._eat("string")
            return tok.v
        if tok.t == "number":
            self._eat("number")
            if "." in tok.v:
                return float(tok.v)
            return int(tok.v)
        if tok.t == "ident":
            if tok.v == "true":
                self._eat("ident")
                return True
            if tok.v == "false":
                self._eat("ident")
                return False
            if tok.v == "nil":
                self._eat("ident")
                return None
            raise LuaParseError(f"Unsupported identifier value at {tok.pos}: {tok.v!r}")
        raise LuaParseError(f"Unexpected token at {tok.pos}: {tok.t}")

    def _parse_table(self) -> Any:
        self._eat("{")
        items: list[tuple[str | int | None, Any]] = []
        array_index = 1

        while self._cur().t != "}":
            if self._cur().t == "ident" and self._peek().t == "=":
                key = self._eat("ident").v
                self._eat("=")
                val = self._parse_value()
                items.append((key, val))
            elif self._cur().t == "[":
                self._eat("[")
                key_val = self._parse_value()
                self._eat("]")
                self._eat("=")
                val = self._parse_value()
                if not isinstance(key_val, (str, int)):
                    raise LuaParseError("Only string/int table keys are supported")
                items.append((key_val, val))
            else:
                val = self._parse_value()
                items.append((array_index, val))
                array_index += 1

            if self._cur().t in (",", ";"):
                self._eat()

        self._eat("}")

        keys = [k for k, _ in items]
        if keys and all(isinstance(k, int) for k in keys):
            n = max(int(k) for k in keys)
            if set(int(k) for k in keys) == set(range(1, n + 1)):
                out: list[Any] = [None] * n
                for k, v in items:
                    out[int(k) - 1] = v
                return out

        out_dict: dict[str, Any] = {}
        for k, v in items:
            if isinstance(k, int):
                out_dict[str(k)] = v
            elif isinstance(k, str):
                out_dict[k] = v
            else:
                raise LuaParseError("Unexpected key type")
        return out_dict


_KEY_RENAMES = {
    "w": "width",
    "h": "height",
    "tileW": "tileWidth",
    "tileH": "tileHeight",
    "frameW": "frameWidth",
    "frameH": "frameHeight",
}


def _rename_keys(obj: Any) -> Any:
    if isinstance(obj, list):
        return [_rename_keys(v) for v in obj]
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            nk = _KEY_RENAMES.get(k, k)
            out[nk] = _rename_keys(v)
        return out
    return obj


def _rewrite_paths_relative_to(base: Path, obj: Any) -> Any:
    if isinstance(obj, list):
        return [_rewrite_paths_relative_to(base, v) for v in obj]
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if k == "path" and isinstance(v, str) and v.lower().endswith(".png"):
                p = Path(v)
                if not p.is_absolute():
                    abs_p = (Path.cwd() / p).resolve()
                else:
                    abs_p = p.resolve()
                try:
                    out[k] = abs_p.relative_to(base.resolve()).as_posix()
                except Exception:
                    out[k] = v
            else:
                out[k] = _rewrite_paths_relative_to(base, v)
        return out
    return obj


def export_manifest(manifest_path: Path, pack_relative: bool) -> dict[str, Any]:
    if manifest_path.suffix.lower() == ".json":
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise SystemExit("JSON manifest must be an object at top-level.")
        return payload

    text = manifest_path.read_text(encoding="utf-8")
    try:
        parsed = Parser(text).parse()
    except LuaParseError as exc:
        raise SystemExit(f"Failed to parse Lua manifest: {exc}") from exc

    if not isinstance(parsed, dict):
        raise SystemExit("Lua manifest must return a table/object.")

    normalized = _rename_keys(parsed)

    if pack_relative:
        base = manifest_path.parent.resolve()
        normalized = _rewrite_paths_relative_to(base, normalized)
        meta = normalized.get("meta")
        if isinstance(meta, dict):
            meta["root"] = "."
        else:
            normalized["meta"] = {"root": "."}

    return normalized


def main() -> None:
    parser = argparse.ArgumentParser(description="Export assets_index.lua to assets_index.json.")
    parser.add_argument("--manifest", type=Path, required=True, help="Path to assets_index.lua (or .json).")
    parser.add_argument("--out", type=Path, required=True, help="Output JSON path.")
    parser.add_argument(
        "--keep-paths",
        action="store_true",
        help="Do not rewrite paths to be relative to the manifest folder.",
    )
    args = parser.parse_args()

    if not args.manifest.exists():
        raise SystemExit(f"Manifest not found: {args.manifest}")

    payload = export_manifest(args.manifest, pack_relative=not args.keep_paths)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()


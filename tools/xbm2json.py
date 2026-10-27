#!/usr/bin/env python3
"""Convert the oneko XBM sprite frames + masks into a single sprites.json.

Each frame becomes {"bits": [row...], "mask": [row...]} where a row is an
unsigned 32-bit int and bit x (LSB-first, XBM order) is the pixel at column x.
Within the mask shape, bits=1 draws the foreground color, bits=0 the background
(same as oneko's XCreatePixmapFromBitmapData + XShapeCombineMask).
"""

import json
import re
import sys
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else (
    Path(__file__).resolve().parent.parent
    / "extension" / "oneko-wayland-legacy@disco-chef" / "sprites.json"
)

BYTES_RE = re.compile(r"0x([0-9a-fA-F]{1,2})")
DEF_RE = re.compile(r"#define\s+\S*_(width|height)\s+(\d+)")


def parse_xbm(path):
    text = path.read_text()
    dims = dict(DEF_RE.findall(text))
    width, height = int(dims["width"]), int(dims["height"])
    data = [int(h, 16) for h in BYTES_RE.findall(text)]
    stride = (width + 7) // 8
    if len(data) < stride * height:
        raise ValueError(f"{path}: expected {stride * height} bytes, got {len(data)}")
    rows = []
    for y in range(height):
        row = 0
        for b in range(stride):
            row |= data[y * stride + b] << (8 * b)
        rows.append(row)
    return width, height, rows


def frame_name(path, variant):
    name = path.stem
    for suffix in (f"_{variant}_mask", "_mask", f"_{variant}"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def load_variant(variant):
    frames = {}
    for path in sorted((ASSETS / "bitmaps" / variant).glob("*.xbm")):
        w, h, rows = parse_xbm(path)
        frames[frame_name(path, variant)] = {"w": w, "h": h, "bits": rows}
    mask_dir = ASSETS / "bitmasks" / variant
    if not mask_dir.is_dir():  # tora ships no masks; it reuses neko's
        mask_dir = ASSETS / "bitmasks" / "neko"
        mask_variant = "neko"
    else:
        mask_variant = variant
    for path in sorted(mask_dir.glob("*.xbm")):
        name = frame_name(path, mask_variant)
        if name in frames:
            _, _, rows = parse_xbm(path)
            frames[name]["mask"] = rows
    missing = [n for n, f in frames.items() if "mask" not in f]
    if missing:
        raise ValueError(f"{variant}: frames without mask: {missing}")
    return frames


def dump(sprites):
    """Readable but compact: one line per frame, so the file diffs and greps
    well without ballooning (full pretty-printing would put every row int on
    its own line)."""
    variants = []
    for variant, frames in sprites.items():
        lines = [
            f"    {json.dumps(name)}: {json.dumps(frame, separators=(',', ':'))}"
            for name, frame in frames.items()
        ]
        variants.append(f"  {json.dumps(variant)}: {{\n" + ",\n".join(lines) + "\n  }")
    return "{\n" + ",\n".join(variants) + "\n}\n"


def main():
    variants = sorted(p.name for p in (ASSETS / "bitmaps").iterdir() if p.is_dir())
    sprites = {v: load_variant(v) for v in variants}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(dump(sprites))
    for v in variants:
        print(f"{v}: {len(sprites[v])} frames")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

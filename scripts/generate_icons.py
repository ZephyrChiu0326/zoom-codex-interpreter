#!/usr/bin/env python3
"""Generate simple PNG icons for the extension without external dependencies."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "extension" / "icons"

BG = (16, 18, 22, 255)
TEAL = (56, 211, 159, 255)
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


def rounded_rect(x: float, y: float, left: float, top: float, right: float, bottom: float, radius: float) -> bool:
    if x < left or x > right or y < top or y > bottom:
        return False
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= radius * radius


def point_in_polygon(x: float, y: float, points: list[tuple[float, float]]) -> bool:
    inside = False
    j = len(points) - 1
    for i, (xi, yi) in enumerate(points):
        xj, yj = points[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi):
            inside = not inside
        j = i
    return inside


def pixel_color(x: float, y: float, size: float) -> tuple[int, int, int, int]:
    if not rounded_rect(x, y, 0.04 * size, 0.04 * size, 0.96 * size, 0.96 * size, 0.22 * size):
        return CLEAR

    bubble = rounded_rect(x, y, 0.16 * size, 0.18 * size, 0.84 * size, 0.68 * size, 0.13 * size)
    tail = point_in_polygon(
        x,
        y,
        [
            (0.28 * size, 0.64 * size),
            (0.46 * size, 0.64 * size),
            (0.30 * size, 0.82 * size),
        ],
    )
    if bubble or tail:
        z_poly = [
            (0.30 * size, 0.28 * size),
            (0.70 * size, 0.28 * size),
            (0.70 * size, 0.37 * size),
            (0.46 * size, 0.37 * size),
            (0.70 * size, 0.55 * size),
            (0.70 * size, 0.64 * size),
            (0.30 * size, 0.64 * size),
            (0.30 * size, 0.55 * size),
            (0.54 * size, 0.55 * size),
            (0.30 * size, 0.37 * size),
        ]
        if point_in_polygon(x, y, z_poly):
            return WHITE
        return TEAL
    return BG


def render(size: int, supersample: int = 4) -> bytes:
    rows = []
    total = supersample * supersample
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            r = g = b = a = 0
            for sy in range(supersample):
                for sx in range(supersample):
                    x = px + (sx + 0.5) / supersample
                    y = py + (sy + 0.5) / supersample
                    cr, cg, cb, ca = pixel_color(x, y, size)
                    r += cr * ca
                    g += cg * ca
                    b += cb * ca
                    a += ca
            if a == 0:
                row.extend((0, 0, 0, 0))
            else:
                row.extend((round(r / a), round(g / a), round(b / a), round(a / total)))
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: Path, size: int) -> None:
    raw = render(size)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main() -> int:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(ICON_DIR / f"icon{size}.png", size)
        print(ICON_DIR / f"icon{size}.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

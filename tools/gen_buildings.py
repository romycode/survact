#!/usr/bin/env python3
"""
Procedural pixel-art buildings for Survact.

Rules that keep the set coherent:
  - 16 px per tile, 3/4 top-down view (front wall + roof visible).
  - One light source: top-left. Left/top edges get the light tone, right/bottom the dark tone.
  - 1 px dark outline on every silhouette. Limited palette (PAL below), no blending except shadows/smoke.
  - Every building exists in two variants: clean and snowed (roof snow, drifts) to match the frost system.

Output: game/assets/buildings/<name>.png and <name>_snow.png, plus a preview sheet.
Usage:  python3 tools/gen_buildings.py [--scale 4]
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from PIL import Image, ImageDraw, ImageFont

TILE = 16
EXTRA_H = 24  # headroom above the footprint for roofs, chimneys, smoke

# ---------------------------------------------------------------------------------------------
# Palette. Every colour used in a sprite comes from here.
# ---------------------------------------------------------------------------------------------
PAL = {
    "out": (27, 30, 38),
    "wood_d": (78, 52, 38), "wood_m": (120, 82, 54), "wood_l": (158, 112, 72),
    "roof_d": (92, 46, 40), "roof_m": (132, 66, 52), "roof_l": (170, 92, 66),
    "stone_d": (70, 72, 84), "stone_m": (104, 106, 120), "stone_l": (142, 145, 158),
    "metal_d": (46, 52, 62), "metal_m": (82, 92, 104), "metal_l": (128, 138, 150), "rivet": (176, 182, 192),
    "snow": (234, 238, 246), "snow_s": (182, 196, 220),
    "glow_d": (196, 82, 36), "glow": (240, 138, 58), "glow_l": (255, 216, 120),
    "win": (255, 204, 100), "win_d": (176, 116, 48),
    "cloth_d": (104, 92, 76), "cloth_m": (150, 134, 106), "cloth_l": (196, 180, 146),
    "log_end": (198, 158, 102), "log_ring": (146, 106, 66),
    "berry": (186, 42, 64), "berry_l": (230, 90, 110), "leaf": (66, 98, 58),
    "door": (44, 34, 30),
    "grass": (74, 107, 58), "grass_d": (60, 90, 48),
}
SHADOW = (10, 12, 20, 90)
SMOKE = [(206, 210, 220, 170), (186, 190, 202, 130), (170, 174, 186, 90)]


def h(x: int, y: int, seed: int = 0) -> float:
    """Deterministic per-pixel hash in [0,1): texture and irregular snow edges."""
    v = (x * 374761393 + y * 668265263 + seed * 2246822519) & 0xFFFFFFFF
    v = ((v ^ (v >> 13)) * 1274126177) & 0xFFFFFFFF
    v ^= v >> 16
    return (v & 0xFFFF) / 65536.0


class Canvas:
    def __init__(self, tiles_w: int, tiles_h: int):
        self.w = tiles_w * TILE
        self.h = tiles_h * TILE + EXTRA_H
        self.img = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        self.px = self.img.load()
        self.ground = self.h - 2  # last row of the footprint used by walls

    def put(self, x: int, y: int, c) -> None:
        if 0 <= x < self.w and 0 <= y < self.h:
            if isinstance(c, str):
                c = PAL[c]
            if len(c) == 3:
                c = (*c, 255)
            if c[3] == 255:
                self.px[x, y] = c
            else:  # alpha over (shadows, smoke)
                r, g, b, a = self.px[x, y]
                if a == 0:  # nothing underneath: keep the colour, carry the alpha
                    self.px[x, y] = c
                    return
                t = c[3] / 255
                na = min(255, a + c[3])
                self.px[x, y] = (int(r + (c[0] - r) * t), int(g + (c[1] - g) * t), int(b + (c[2] - b) * t), na)

    def get_alpha(self, x: int, y: int) -> int:
        return self.px[x, y][3] if 0 <= x < self.w and 0 <= y < self.h else 0

    def rect(self, x0, y0, x1, y1, c) -> None:
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.put(x, y, c)

    def box(self, x0, y0, x1, y1, fill) -> None:
        """Filled rect with 1px outline."""
        self.rect(x0, y0, x1, y1, "out")
        if x1 - x0 >= 2 and y1 - y0 >= 2:
            self.rect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, fill)

    def hline(self, x0, x1, y, c) -> None:
        for x in range(x0, x1 + 1):
            self.put(x, y, c)

    def vline(self, x, y0, y1, c) -> None:
        for y in range(y0, y1 + 1):
            self.put(x, y, c)

    def shadow(self, x0, x1, y, depth=3) -> None:
        """Soft ground shadow cast down-right (light from top-left)."""
        for d in range(depth):
            self.hline(x0 + 2 + d, x1 + 2, y + d, SHADOW)


# ---------------------------------------------------------------------------------------------
# Building parts
# ---------------------------------------------------------------------------------------------
def plank_wall(cv: Canvas, x0, y0, x1, y1, seed=1) -> None:
    cv.box(x0, y0, x1, y1, "wood_m")
    for y in range(y0 + 1, y1):
        row = (y - y0 - 1) % 3
        for x in range(x0 + 1, x1):
            if row == 2:
                cv.put(x, y, "wood_d")  # plank seam
            elif row == 0 and x < x0 + 3:
                cv.put(x, y, "wood_l")  # lit left edge
            elif h(x, y, seed) < 0.08:
                cv.put(x, y, "wood_d")  # grain
    cv.vline(x1 - 1, y0 + 1, y1 - 1, "wood_d")  # shaded right edge


def stone_wall(cv: Canvas, x0, y0, x1, y1, seed=2) -> None:
    cv.box(x0, y0, x1, y1, "stone_m")
    for y in range(y0 + 1, y1):
        course = (y - y0 - 1) // 3
        in_course = (y - y0 - 1) % 3
        offset = 3 if course % 2 else 0
        for x in range(x0 + 1, x1):
            if in_course == 2 or (x - x0 + offset) % 6 == 0:
                cv.put(x, y, "stone_d")  # mortar
            elif in_course == 0 and h(x, y, seed) < 0.5:
                cv.put(x, y, "stone_l")
    cv.vline(x1 - 1, y0 + 1, y1 - 1, "stone_d")


def roof(cv: Canvas, x0, y0, x1, y1, snow: bool, mat=("roof_l", "roof_m", "roof_d"), seed=3) -> None:
    """Front slope of a pitched roof seen from above: ridge at top, eave at bottom, 1px overhang."""
    light, mid, dark = mat
    cv.box(x0, y0, x1, y1, mid)
    height = y1 - y0
    for y in range(y0 + 1, y1):
        t = (y - y0) / max(1, height)
        tone = light if t < 0.3 else (mid if t < 0.75 else dark)
        for x in range(x0 + 1, x1):
            c = tone
            if (y - y0) % 3 == 0:
                c = dark if tone != dark else "out"  # shingle rows
            elif (x + (y // 3) * 2) % 5 == 0:
                c = dark  # staggered shingle joints
            cv.put(x, y, c)
    cv.hline(x0 + 1, x1 - 1, y0 + 1, light)  # ridge highlight
    cv.vline(x1 - 1, y0 + 1, y1 - 1, dark)
    if snow:
        snow_cap(cv, x0, y0, x1, y0 + max(3, height // 2), seed)


def snow_cap(cv: Canvas, x0, y0, x1, y_end, seed=4) -> None:
    """Snow layer with an irregular, dripping lower edge. Keeps the outline on the sides."""
    for x in range(x0, x1 + 1):
        depth = y_end - y0 - int(h(x, 0, seed) * 3)
        if h(x, 1, seed) < 0.18:
            depth += 2  # icicle-ish drip
        for y in range(y0, y0 + depth + 1):
            if cv.get_alpha(x, y) == 0:
                continue
            on_edge = x in (x0, x1) or y == y0
            if on_edge:
                cv.put(x, y, "out")
            elif y == y0 + depth:
                cv.put(x, y, "snow_s")  # shadow under the snow lip
            else:
                cv.put(x, y, "snow" if (x - x0) > 1 or y > y0 + 1 else "snow")
    # top-left sparkle
    cv.put(x0 + 2, y0 + 1, (255, 255, 255))


def snow_drift(cv: Canvas, x0, x1, y, seed=5) -> None:
    """Little snow banks at the foot of walls."""
    for x in range(x0, x1 + 1):
        if h(x, y, seed) < 0.55:
            cv.put(x, y, "snow")
            if h(x, y + 1, seed) < 0.4:
                cv.put(x, y - 1, "snow_s")


def door(cv: Canvas, x0, y1, w=4, hgt=6) -> None:
    cv.box(x0 - 1, y1 - hgt, x0 + w, y1, "door")
    cv.vline(x0, y1 - hgt + 1, y1 - 1, "wood_d")
    cv.put(x0 + w - 1, y1 - hgt // 2, "glow_l")  # handle


def window(cv: Canvas, x, y, lit=True, w=3, hgt=3) -> None:
    cv.box(x - 1, y - 1, x + w, y + hgt, "win" if lit else "metal_d")
    if lit:
        cv.hline(x, x + w - 1, y + hgt - 1, "win_d")
        cv.vline(x + w // 2, y, y + hgt - 1, "wood_d")  # mullion
        # warm spill on the snow / ground below
        cv.hline(x - 1, x + w, y + hgt + 2, (255, 200, 100, 40))


def chimney(cv: Canvas, x, y_top, y_bottom, smoke=True, seed=6) -> None:
    cv.box(x, y_top, x + 3, y_bottom, "stone_m")
    cv.put(x + 1, y_top + 1, "stone_l")
    cv.vline(x + 2, y_top + 1, y_bottom - 1, "stone_d")
    if smoke:
        puffs = [(x + 1, y_top - 3, 2), (x + 3, y_top - 7, 2), (x + 2, y_top - 11, 3)]
        for i, (px, py, r) in enumerate(puffs):
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    if dx * dx + dy * dy <= r * r and h(px + dx, py + dy, seed) < 0.85:
                        cv.put(px + dx, py + dy, SMOKE[min(i, 2)])


def log_end(cv: Canvas, cx, cy) -> None:
    """2x2 core log end with outline: reads as a stacked log at this scale."""
    cv.box(cx - 1, cy - 1, cx + 2, cy + 2, "log_end")
    cv.put(cx, cy, "log_ring")
    cv.put(cx + 1, cy + 1, "wood_m")


def log_pile(cv: Canvas, x0, y_base, cols=4, rows=3) -> None:
    for r in range(rows):
        n = cols - r
        for i in range(n):
            log_end(cv, x0 + i * 3 + r * 1 + 1, y_base - 2 - r * 3)


def crate(cv: Canvas, x0, y0, size=6) -> None:
    """3/4 crate: lit top face + front face with cross brace."""
    top = size // 3
    cv.box(x0, y0, x0 + size, y0 + top, "wood_l")
    cv.box(x0, y0 + top, x0 + size, y0 + size + top, "wood_m")
    for i in range(1, size):
        cv.put(x0 + i, y0 + top + i, "wood_d")
    cv.vline(x0 + size - 1, y0 + top + 1, y0 + size + top - 1, "wood_d")


def basket(cv: Canvas, x0, y0, berries=True) -> None:
    cv.box(x0, y0, x0 + 6, y0 + 4, "wood_l")
    for x in range(x0 + 1, x0 + 6):
        if x % 2:
            cv.vline(x, y0 + 2, y0 + 3, "wood_m")
    if berries:
        for i, (dx, dy) in enumerate([(1, -1), (3, -1), (5, -1), (2, -2), (4, -2), (3, -3)]):
            cv.put(x0 + dx, y0 + dy + 1, "berry_l" if i % 3 == 0 else "berry")
        cv.put(x0 + 2, y0 - 1, "leaf")


def ground_patch(cv: Canvas, x0, y0, x1, y1, fill="wood_d", seed=7) -> None:
    """Packed floor / platform the building stands on (helps it sit on the map)."""
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            edge = x in (x0, x1) or y in (y0, y1)
            cv.put(x, y, "out" if edge else (fill if h(x, y, seed) > 0.12 else "wood_m"))


# ---------------------------------------------------------------------------------------------
# Buildings
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Building:
    name: str
    title: str
    tiles: tuple[int, int]
    draw: Callable[[Canvas, bool], None]


def draw_heater(cv: Canvas, snow: bool) -> None:
    """The heart of the colony: a riveted iron furnace with a tall stack. 3x3."""
    g = cv.ground
    cx = cv.w // 2
    # octagonal stone plinth
    cv.shadow(4, cv.w - 6, g - 1, depth=3)
    for y in range(g - 12, g + 1):
        inset = max(0, (g - 12 + 3) - y) + max(0, y - (g - 3))
        x0, x1 = 4 + inset, cv.w - 5 - inset
        for x in range(x0, x1 + 1):
            edge = x in (x0, x1) or y in (g - 12, g)
            top_face = y < g - 5
            c = "out" if edge else ("stone_l" if top_face and h(x, y, 8) < 0.35 else ("stone_m" if top_face else "stone_d"))
            cv.put(x, y, c)
    cv.hline(5, cv.w - 6, g - 5, "out")

    # cylindrical body: vertical shading bands left (lit) -> right (dark)
    bx0, bx1 = cx - 11, cx + 10
    by0, by1 = g - 34, g - 7
    cv.box(bx0, by0, bx1, by1, "metal_m")
    width = bx1 - bx0
    for x in range(bx0 + 1, bx1):
        t = (x - bx0) / width
        tone = "metal_l" if t < 0.28 else ("metal_m" if t < 0.7 else "metal_d")
        cv.vline(x, by0 + 1, by1 - 1, tone)
    # iron bands with rivets
    for yb in (by0 + 4, by0 + 13, by1 - 3):
        cv.hline(bx0 + 1, bx1 - 1, yb, "metal_d")
        for x in range(bx0 + 2, bx1 - 1, 4):
            cv.put(x, yb, "rivet")
    # furnace mouth
    mx0, mx1, my0, my1 = cx - 5, cx + 4, by1 - 10, by1 - 4
    cv.box(mx0, my0, mx1, my1, "glow_d")
    cv.rect(mx0 + 1, my0 + 2, mx1 - 1, my1 - 1, "glow")
    cv.rect(mx0 + 3, my0 + 3, mx1 - 3, my1 - 1, "glow_l")
    for x in range(mx0 + 1, mx1, 2):
        cv.vline(x, my0 + 1, my1 - 1, "metal_d")  # grate bars
    # glow spill on plinth
    cv.hline(mx0 - 2, mx1 + 2, by1 + 2, (255, 170, 80, 90))
    cv.hline(mx0, mx1, by1 + 3, (255, 170, 80, 60))
    # conical top + stack
    for i in range(5):
        cv.hline(bx0 + 2 + i * 2, bx1 - 2 - i * 2, by0 - 1 - i, "out" if i == 4 else ("metal_l" if i < 2 else "metal_m"))
        cv.put(bx0 + 2 + i * 2, by0 - 1 - i, "out")
        cv.put(bx1 - 2 - i * 2, by0 - 1 - i, "out")
    sx0, sx1 = cx - 3, cx + 2
    cv.box(sx0, 1, sx1, by0 - 4, "metal_m")
    cv.vline(sx0 + 1, 2, by0 - 5, "metal_l")
    cv.vline(sx1 - 1, 2, by0 - 5, "metal_d")
    cv.hline(sx0 - 1, sx1 + 1, 1, "out")
    cv.hline(sx0, sx1, 2, "glow")  # hot rim
    cv.hline(sx0 + 1, sx1 - 1, 0, (255, 200, 110, 140))
    if snow:
        snow_cap(cv, bx0 + 2, by0 - 5, bx1 - 2, by0 - 3, seed=9)
        snow_drift(cv, 6, cv.w - 8, g - 12, seed=10)
        snow_drift(cv, 4, cv.w - 6, g + 1, seed=11)


def draw_stockpile(cv: Canvas, snow: bool) -> None:
    """Open wooden platform with crates and a log stack. 2x2."""
    g = cv.ground
    cv.shadow(2, cv.w - 4, g - 1)
    ground_patch(cv, 1, g - 22, cv.w - 3, g)
    # planks
    for y in range(g - 21, g):
        if (y - g) % 4 == 0:
            cv.hline(2, cv.w - 4, y, "wood_m")
    # corner posts
    for x in (1, cv.w - 4):
        cv.box(x, g - 28, x + 2, g - 1, "wood_m")
        cv.put(x + 1, g - 27, "wood_l")
    cv.hline(1, cv.w - 2, g - 28, "out")
    cv.hline(2, cv.w - 3, g - 27, "wood_l")
    crate(cv, 4, g - 16, 6)
    crate(cv, 9, g - 10, 6)
    log_pile(cv, 17, g - 1, cols=4, rows=3)
    if snow:
        snow_cap(cv, 1, g - 28, cv.w - 2, g - 27, seed=12)
        snow_cap(cv, 4, g - 16, 10, g - 15, seed=13)
        snow_drift(cv, 1, cv.w - 3, g + 1)


def draw_tent(cv: Canvas, snow: bool) -> None:
    """Canvas A-frame: first shelter. 1x1."""
    g = cv.ground
    apex_y, base_y = g - 17, g
    cx = cv.w // 2
    cv.shadow(2, cv.w - 3, g - 1, depth=2)
    for y in range(apex_y, base_y + 1):
        half = int((y - apex_y) * 0.42) + 1
        x0, x1 = cx - half, cx + half - 1
        for x in range(x0, x1 + 1):
            if x in (x0, x1) or y == base_y:
                cv.put(x, y, "out")
            else:
                cv.put(x, y, "cloth_l" if x < cx - 1 else ("cloth_m" if x < cx + 2 else "cloth_d"))
    # entrance
    for y in range(g - 7, g):
        half = (y - (g - 7)) // 2
        cv.hline(cx - half - 1, cx + half, y, "door")
    cv.vline(cx - 1, apex_y + 1, g - 8, "cloth_d")  # seam
    # pole + guy ropes
    cv.vline(cx - 1, apex_y - 2, apex_y, "wood_d")
    cv.put(1, g, "wood_d")
    cv.put(cv.w - 2, g, "wood_d")
    if snow:
        snow_cap(cv, cx - 4, apex_y + 2, cx + 3, apex_y + 5, seed=14)
        snow_drift(cv, 1, cv.w - 2, g + 1)


def draw_cabin(cv: Canvas, snow: bool) -> None:
    """Log cabin: main housing. 2x2."""
    g = cv.ground
    cv.shadow(1, cv.w - 3, g - 1)
    wall_top = g - 12
    plank_wall(cv, 2, wall_top, cv.w - 3, g)
    door(cv, 12, g - 1)
    window(cv, 5, wall_top + 3)
    window(cv, 21, wall_top + 3)
    chimney(cv, 22, wall_top - 26, wall_top - 14, smoke=True)
    roof(cv, 0, wall_top - 18, cv.w - 1, wall_top, snow)
    if snow:
        snow_drift(cv, 1, cv.w - 2, g + 1)


def draw_woodcutter(cv: Canvas, snow: bool) -> None:
    """Woodcutter's lodge: small hut + log pile + chopping block. 2x2."""
    g = cv.ground
    cv.shadow(1, cv.w - 3, g - 1)
    wall_top = g - 10
    plank_wall(cv, 1, wall_top, 18, g)
    door(cv, 6, g - 1)
    roof(cv, 0, wall_top - 14, 19, wall_top, snow)
    log_pile(cv, 19, g - 1, cols=4, rows=3)
    # chopping block with axe, in front-right
    cv.box(21, g - 15, 26, g - 11, "log_end")
    cv.put(23, g - 13, "log_ring")
    cv.vline(24, g - 21, g - 15, "wood_l")  # axe handle
    cv.box(25, g - 21, 27, g - 18, "metal_l")
    cv.put(27, g - 19, "rivet")
    if snow:
        snow_drift(cv, 1, cv.w - 2, g + 1)
        cv.hline(22, 25, g - 15, "snow")


def draw_gatherer(cv: Canvas, snow: bool) -> None:
    """Gatherer's hut: cloth-roofed lean-to with berry baskets. 2x2."""
    g = cv.ground
    cv.shadow(1, cv.w - 3, g - 1)
    wall_top = g - 10
    plank_wall(cv, 3, wall_top, cv.w - 4, g)
    door(cv, 13, g - 1)
    roof(cv, 1, wall_top - 13, cv.w - 2, wall_top, snow, mat=("cloth_l", "cloth_m", "cloth_d"), seed=15)
    basket(cv, 2, g - 4)
    basket(cv, cv.w - 9, g - 4)
    window(cv, 6, wall_top + 3)
    if snow:
        snow_drift(cv, 1, cv.w - 2, g + 1)


def draw_kitchen(cv: Canvas, snow: bool) -> None:
    """Stone cookhouse with big chimney: turns raw food into meals. 2x2."""
    g = cv.ground
    cv.shadow(1, cv.w - 3, g - 1)
    wall_top = g - 13
    stone_wall(cv, 2, wall_top, cv.w - 3, g)
    door(cv, 6, g - 1)
    window(cv, 17, wall_top + 3, w=6, hgt=4)
    chimney(cv, 4, wall_top - 28, wall_top - 13, smoke=True)
    cv.box(3, wall_top - 28, 8, wall_top - 26, "stone_l")  # wider chimney cap
    roof(cv, 0, wall_top - 16, cv.w - 1, wall_top, snow, mat=("stone_l", "stone_m", "stone_d"), seed=16)
    if snow:
        snow_drift(cv, 1, cv.w - 2, g + 1)


def draw_workshop(cv: Canvas, snow: bool) -> None:
    """Workshop: research / tools. Wide barn doors, anvil outside. 3x2."""
    g = cv.ground
    cv.shadow(1, cv.w - 3, g - 1)
    wall_top = g - 14
    plank_wall(cv, 2, wall_top, cv.w - 12, g)
    stone_wall(cv, cv.w - 12, wall_top, cv.w - 3, g)
    # double barn door
    cv.box(8, g - 10, 21, g, "wood_d")
    cv.vline(14, g - 9, g - 1, "out")
    for i in range(1, 6):
        cv.put(8 + i, g - 10 + i * 2 - 1, "wood_m")
        cv.put(21 - i, g - 10 + i * 2 - 1, "wood_m")
    window(cv, cv.w - 9, wall_top + 3, lit=True, w=4)
    chimney(cv, cv.w - 8, wall_top - 26, wall_top - 15, smoke=True)
    roof(cv, 0, wall_top - 17, cv.w - 1, wall_top, snow, seed=17)
    # anvil
    ax = 25
    cv.box(ax, g - 5, ax + 7, g - 3, "metal_m")
    cv.hline(ax + 1, ax + 6, g - 4, "metal_l")
    cv.box(ax + 2, g - 3, ax + 5, g, "metal_d")
    if snow:
        snow_drift(cv, 1, cv.w - 2, g + 1)


BUILDINGS = [
    Building("heater", "Generador", (3, 3), draw_heater),
    Building("stockpile", "Almacén", (2, 2), draw_stockpile),
    Building("tent", "Tienda", (1, 1), draw_tent),
    Building("cabin", "Cabaña", (2, 2), draw_cabin),
    Building("woodcutter", "Leñador", (2, 2), draw_woodcutter),
    Building("gatherer", "Recolector", (2, 2), draw_gatherer),
    Building("kitchen", "Cocina", (2, 2), draw_kitchen),
    Building("workshop", "Taller", (3, 2), draw_workshop),
]


def render(b: Building, snow: bool) -> Image.Image:
    cv = Canvas(*b.tiles)
    b.draw(cv, snow)
    return cv.img


def preview_sheet(images: list[tuple[Building, Image.Image, Image.Image]], scale: int) -> Image.Image:
    """Clean and snowed variant side by side, on grass/snow ground with a tile grid, labelled."""
    pad = 10
    label_h = 12
    cell_w = max(img.width for _, img, _ in images) * 2 + pad * 3
    rows = []
    for b, clean, snowed in images:
        rows.append(max(clean.height, snowed.height) + label_h + pad * 2)
    sheet = Image.new("RGBA", (cell_w * 2, sum(rows[i] for i in range(0, len(rows), 2)) + max(rows)), PAL["out"] + (255,))
    draw = ImageDraw.Draw(sheet)
    labels: list[tuple[int, int, str]] = []
    y = 0
    for i, (b, clean, snowed) in enumerate(images):
        col = i % 2
        x = col * cell_w
        row_h = max(rows[i - col: i - col + 2])
        for k, (img, bg) in enumerate([(clean, PAL["grass"]), (snowed, (196, 206, 222))]):
            gx = x + pad + k * (img.width + pad) if False else x + pad + k * (cell_w // 2 - pad // 2)
            gy = y + label_h + pad
            ground_y = gy + img.height - b.tiles[1] * TILE
            draw.rectangle([gx - 2, ground_y - 1, gx + img.width + 1, gy + img.height + 1], fill=bg + (255,))
            for tx in range(b.tiles[0] + 1):  # footprint grid
                draw.line([gx + tx * TILE, ground_y, gx + tx * TILE, gy + img.height], fill=(0, 0, 0, 40))
            for ty in range(b.tiles[1] + 1):
                draw.line([gx, ground_y + ty * TILE, gx + img.width, ground_y + ty * TILE], fill=(0, 0, 0, 40))
            sheet.alpha_composite(img, (gx, gy))
        labels.append((x + pad, y + 1, f"{b.title}  {b.tiles[0]}x{b.tiles[1]}"))
        if col == 1 or i == len(images) - 1:
            y += row_h
    sheet = sheet.crop((0, 0, sheet.width, y))
    sheet = sheet.resize((sheet.width * scale, sheet.height * scale), Image.NEAREST)
    # Labels drawn after upscaling with a real font (accents render correctly).
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("DejaVuSansMono-Bold.ttf", 9 * scale)
    except OSError:
        font = ImageFont.load_default()
    for (lx, ly, text) in labels:
        draw.text((lx * scale, ly * scale), text, fill=PAL["glow_l"] + (255,), font=font)
    return sheet


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "game" / "assets" / "buildings"))
    ap.add_argument("--scale", type=int, default=4, help="preview upscale factor")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rendered = []
    for b in BUILDINGS:
        clean, snowed = render(b, False), render(b, True)
        clean.save(out / f"{b.name}.png")
        snowed.save(out / f"{b.name}_snow.png")
        rendered.append((b, clean, snowed))
    preview_sheet(rendered, args.scale).save(out / "_preview.png")
    print(f"{len(BUILDINGS) * 2} sprites -> {out}")


if __name__ == "__main__":
    main()

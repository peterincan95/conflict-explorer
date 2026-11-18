"""Project Natural Earth country outlines onto the same grid as the events.

Reads   raw-data/ne_50m_admin_0_countries/ne_50m_admin_0_countries.shp
Writes  public/data/outlines.bin, public/data/labels.json

outlines.bin holds line segments, 8 bytes each, little-endian: the x and y of the
segment's start, then of its end, as uint16 on the events' Equal Earth grid. Each
country's rings become separate segments, so coastlines and borders draw in one
call. Borders shared by two countries appear twice, which the renderer's MAX
blending hides.

labels.json lists each country's label spot on the same grid, with Natural
Earth's MIN_LABEL (the web map zoom where the label should first appear), most
important first.
"""
import json
from pathlib import Path

import numpy as np
import shapefile

from prep_data import X_MAX, Y_MAX, equal_earth, scale

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "raw-data" / "ne_50m_admin_0_countries" / "ne_50m_admin_0_countries.shp"
OUT = ROOT / "public" / "data" / "outlines.bin"
LABELS = ROOT / "public" / "data" / "labels.json"


def build_labels(reader: shapefile.Reader):
    rows = []
    for record in reader.records():
        x, y = equal_earth(np.array([record["LABEL_X"]]), np.array([record["LABEL_Y"]]))
        rows.append({
            "name": record["NAME"],
            "x": int(scale(x, X_MAX)[0]),
            "y": int(scale(y, Y_MAX)[0]),
            "minZoom": float(record["MIN_LABEL"]),
            "population": int(record["POP_EST"]),
        })
    rows.sort(key=lambda row: (row["minZoom"], -row["population"]))
    for row in rows:
        del row["population"]
    LABELS.write_text(json.dumps(rows, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{len(rows)} labels")


def main():
    reader = shapefile.Reader(SOURCE)
    build_labels(reader)
    segments = []
    for shape in reader.shapes():
        points = np.array(shape.points)
        starts = list(shape.parts) + [len(points)]
        for first, last in zip(starts[:-1], starts[1:]):
            lon, lat = points[first:last, 0], points[first:last, 1]
            x, y = equal_earth(lon, lat)
            grid = np.stack([scale(x, X_MAX), scale(y, Y_MAX)], axis=1)
            # Points that land on the same grid cell add nothing.
            keep = np.ones(len(grid), dtype=bool)
            keep[1:] = np.any(grid[1:] != grid[:-1], axis=1)
            grid = grid[keep]
            if len(grid) < 2:
                continue
            segments.append(np.concatenate([grid[:-1], grid[1:]], axis=1))
    lines = np.concatenate(segments).astype("<u2")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    lines.tofile(OUT)
    print(f"{len(lines):,} segments, {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()

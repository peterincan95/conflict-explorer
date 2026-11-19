"""Project Natural Earth lines, label spots and the PRISMA hillshade onto the events' grid.

Reads   raw-data/revised-natural-earth/{50m,10m}/...   Natural Earth vectors
        raw-data/revised-natural-earth/PRISMA_SR_50M/PRIMSA_SR_50M.tif
Writes  public/data/lines-50m.bin, public/data/lines-10m.bin
        public/data/basemap.json
        public/data/hillshade.webp

lines-*.bin hold line segments, 8 bytes each, little-endian: the x and y of the
segment's start, then of its end, as uint16 on the events' Equal Earth grid. Each
file holds coastlines, then country borders, then province borders; basemap.json
says how many segments each has. The 50m file draws the zoomed-out map and the 10m
file takes over closer in.

basemap.json also holds label spots for countries, provinces and populated places,
each with the web map zoom where it first shows, sorted by that zoom and then by
importance, which decides which label wins when two collide. Country and province spots are the point deepest inside
each one's largest piece, so labels sit well inside their borders.

hillshade.webp is the hillshade in Equal Earth, gray. Water is filled with the gray of
flat land, which basemap.json gives, so seas and lakes show no relief and blurring the
image as the map zooms out leaves no dark fringe along coasts.
"""
import json
import math
from pathlib import Path

import numpy as np
import shapefile
from PIL import Image, ImageDraw
from shapely.geometry import LineString, Polygon
from shapely.ops import polylabel

from prep_data import A1, A2, A3, A4, M, X_MAX, Y_MAX, equal_earth, scale

ROOT = Path(__file__).resolve().parent.parent
NE = ROOT / "raw-data" / "revised-natural-earth"
OUT = ROOT / "public" / "data"
GRID = 65535

# Line detail: points closer than this many grid cells to a simplified line drop out.
SIMPLIFY = {"50m": 2.0, "10m": 0.5}
LINE_LAYERS = {
    "50m": ["ne_50m_coastline", "ne_50m_admin_0_boundary_lines_land", "ne_50m_admin_1_states_provinces_lines"],
    "10m": ["ne_10m_coastline", "ne_10m_admin_0_boundary_lines_land", "ne_10m_admin_1_states_provinces_lines"],
}
LINE_KINDS = ["coast", "border", "province"]

# Hillshade output width in pixels; the height follows Equal Earth's shape.
HILLSHADE_WIDTH = 8192
HILLSHADE_QUALITY = 82
HILLSHADE = NE / "PRISMA_SR_50M" / "PRIMSA_SR_50M.tif"
# The source grid: 1/45 of a degree per pixel, from 180°W and 90°N.
SOURCE_STEP = 1 / 45

# When labels first show, by web map zoom, from Natural Earth's ranks. Natural Earth
# also suggests a zoom for each country and province; labels never show more than
# MIN_LABEL_LEAD before it, which holds back small territories ranked like countries.
COUNTRY_ZOOM = lambda labelrank: 0.8 * labelrank          # noqa: E731
PROVINCE_ZOOM = lambda labelrank: 4.5 + 0.5 * labelrank   # noqa: E731
PLACE_ZOOM = lambda scalerank: 2.4 + 0.9 * scalerank      # noqa: E731
MIN_LABEL_LEAD = 1
# Country labels also wait until the country's largest piece is about this many pixels
# across on screen (the square root of its area), so small countries name themselves
# only once there's room. Web map zoom 0 shows the whole world 256 pixels wide.
COUNTRY_MIN_PIXELS = 44
WEB_TILE_PIXELS = 256
# Provinces with Natural Earth's labelrank 20 are unranked; they never get a label.
UNRANKED = 20
# Labels on pieces smaller than this share of the grid would never fit.
MIN_LABEL_AREA = 2e-7


def reader(scale_name: str, layer: str) -> shapefile.Reader:
    return shapefile.Reader(str(NE / scale_name / layer / layer), encoding="utf-8")


def to_grid(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    x, y = equal_earth(lon, lat)
    return np.stack([scale(x, X_MAX), scale(y, Y_MAX)], axis=1).astype(np.float64)


def parts(shape):
    starts = list(shape.parts) + [len(shape.points)]
    points = np.array(shape.points)
    for first, last in zip(starts[:-1], starts[1:]):
        if last - first >= 2:
            yield points[first:last]


def segments_for(layer_reader: shapefile.Reader, tolerance: float) -> np.ndarray:
    """Each line, projected and simplified, as start and end points on the grid."""
    out = []
    for shape in layer_reader.shapes():
        for part in parts(shape):
            grid = to_grid(part[:, 0], part[:, 1])
            line = np.rint(np.array(LineString(grid).simplify(tolerance).coords))
            # Points on the same grid cell add nothing.
            keep = np.ones(len(line), dtype=bool)
            keep[1:] = np.any(line[1:] != line[:-1], axis=1)
            line = line[keep]
            if len(line) >= 2:
                out.append(np.concatenate([line[:-1], line[1:]], axis=1))
    return np.concatenate(out).astype("<u2")


def build_lines():
    counts = {}
    for scale_name, layers in LINE_LAYERS.items():
        groups = [segments_for(reader(scale_name, layer), SIMPLIFY[scale_name]) for layer in layers]
        counts[scale_name] = {kind: len(group) for kind, group in zip(LINE_KINDS, groups)}
        data = np.concatenate(groups)
        data.tofile(OUT / f"lines-{scale_name}.bin")
        print(f"lines-{scale_name}.bin: {counts[scale_name]}, {data.nbytes / 1e6:.1f} MB")
    return counts


def largest_piece(shape) -> Polygon | None:
    """The biggest outer ring of a shape, with its holes, on the grid."""
    rings = [to_grid(part[:, 0], part[:, 1]) for part in parts(shape)]
    # Shapefile outer rings run clockwise, holes counterclockwise; on the grid, y runs
    # up as latitude does, so the sign of the area keeps its meaning.
    outers, holes = [], []
    for ring in rings:
        if len(ring) < 4:
            continue
        area = 0.5 * np.sum(ring[:-1, 0] * ring[1:, 1] - ring[1:, 0] * ring[:-1, 1])
        (outers if area < 0 else holes).append(ring)
    pieces = [Polygon(outer).buffer(0) for outer in outers]
    pieces = [piece for piece in pieces if not piece.is_empty]
    if not pieces:
        return None
    best = max(pieces, key=lambda piece: piece.area)
    if best.geom_type == "MultiPolygon":
        best = max(best.geoms, key=lambda piece: piece.area)
    for hole in holes:
        hole_polygon = Polygon(hole).buffer(0)
        if best.intersects(hole_polygon):
            best = best.difference(hole_polygon)
    if best.geom_type == "MultiPolygon":
        best = max(best.geoms, key=lambda piece: piece.area)
    return best


def label_spot(shape):
    """The label spot on the grid, and the width of the piece it's in, in grid units."""
    piece = largest_piece(shape)
    if piece is None or piece.is_empty or piece.area < MIN_LABEL_AREA * GRID * GRID:
        return None
    size = math.sqrt(piece.area)
    spot = polylabel(piece, tolerance=max(1.0, size / 200))
    return int(round(spot.x)), int(round(spot.y)), size


def size_zoom(size: float) -> float:
    """The web map zoom where a piece this many grid units across reaches COUNTRY_MIN_PIXELS."""
    return math.log2(COUNTRY_MIN_PIXELS * GRID / (WEB_TILE_PIXELS * size))


def build_labels():
    countries = []
    country_reader = reader("10m", "ne_10m_admin_0_countries")
    for shape, record in zip(country_reader.shapes(), country_reader.records()):
        spot = label_spot(shape)
        if spot is None:
            continue
        countries.append({
            "name": record["NAME"], "x": spot[0], "y": spot[1],
            "minZoom": round(max(
                COUNTRY_ZOOM(record["LABELRANK"]),
                record["MIN_LABEL"] - MIN_LABEL_LEAD,
                size_zoom(spot[2]),
            ), 2),
            "rank": [record["LABELRANK"], record["scalerank"], -(record["POP_EST"] or 0)],
        })

    provinces = []
    province_reader = reader("10m", "ne_10m_admin_1_states_provinces")
    for shape, record in zip(province_reader.shapes(), province_reader.records()):
        if record["labelrank"] >= UNRANKED or not record["name"]:
            continue
        spot = label_spot(shape)
        if spot is None:
            continue
        provinces.append({
            "name": record["name_en"] or record["name"], "x": spot[0], "y": spot[1],
            "minZoom": round(max(PROVINCE_ZOOM(record["labelrank"]), (record["min_label"] or 0) - MIN_LABEL_LEAD), 2),
            "rank": [record["labelrank"], record["scalerank"], 0],
        })

    places = []
    place_reader = reader("10m", "ne_10m_populated_places")
    for record in place_reader.records():
        if record["FEATURECLA"] in ("Scientific station", "Meteorological Station", "Historic place"):
            continue
        grid = to_grid(np.array([record["LONGITUDE"]]), np.array([record["LATITUDE"]]))[0]
        places.append({
            "name": record["NAME"], "x": int(grid[0]), "y": int(grid[1]),
            "minZoom": round(PLACE_ZOOM(record["SCALERANK"]), 2),
            "capital": record["ADM0CAP"] == 1,
            # Some places have no labelrank; they go after the ranked ones.
            "rank": [record["SCALERANK"], record["LABELRANK"] or 99, -(record["POP_MAX"] or 0)],
        })

    def finish(rows):
        rows.sort(key=lambda row: (row["minZoom"], *row["rank"]))
        for row in rows:
            del row["rank"]
        return rows

    labels = {"countries": finish(countries), "provinces": finish(provinces), "places": finish(places)}
    print(f"labels: {len(countries)} countries, {len(provinces)} provinces, {len(places)} places")
    return labels


def inverse_equal_earth(x: np.ndarray, y: np.ndarray):
    """Longitude and latitude in degrees for Equal Earth x and y, NaN outside the map."""
    theta = y / A1
    for _ in range(12):
        t2 = theta * theta
        t6 = t2 * t2 * t2
        f = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)) - y
        derivative = A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)
        theta = theta - f / derivative
    t2 = theta * theta
    t6 = t2 * t2 * t2
    derivative = A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)
    lon = M * x * derivative / np.cos(theta)
    lat = np.arcsin(np.clip(np.sin(theta) / M, -1, 1))
    outside = np.abs(lon) > math.pi
    return np.degrees(np.where(outside, np.nan, lon)), np.degrees(lat)


def land_mask(width: int, height: int) -> np.ndarray:
    """1 on land, 0 on sea and lakes, drawn at the hillshade's size."""
    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)
    to_pixels = lambda grid: [  # noqa: E731
        (gx / GRID * width, (1 - gy / GRID) * height) for gx, gy in grid
    ]
    for layer, value in [("ne_50m_land", 255), ("ne_50m_lakes", 0)]:
        for shape in reader("50m", layer).shapes():
            # Draw each ring on its own: outer rings fill, and holes (inland seas) clear.
            for part in parts(shape):
                ring = to_grid(part[:, 0], part[:, 1])
                area = 0.5 * np.sum(ring[:-1, 0] * ring[1:, 1] - ring[1:, 0] * ring[:-1, 1])
                fill = value if area < 0 else 255 - value
                draw.polygon(to_pixels(ring), fill=fill)
    return np.asarray(image) > 127


def build_hillshade():
    Image.MAX_IMAGE_PIXELS = None
    source = np.asarray(Image.open(HILLSHADE), dtype=np.float32)
    rows, columns = source.shape
    width = HILLSHADE_WIDTH
    height = round(width * Y_MAX / X_MAX)
    out = np.zeros((height, width), dtype=np.float32)
    xs = ((np.arange(width) + 0.5) / width * 2 - 1) * X_MAX
    for start in range(0, height, 256):
        stop = min(height, start + 256)
        ys = (1 - (np.arange(start, stop) + 0.5) / height * 2) * Y_MAX
        x, y = np.meshgrid(xs, ys)
        lon, lat = inverse_equal_earth(x, y)
        # Bilinear sampling from the source grid, whose pixel centers sit half a step in.
        col = (lon + 180) / SOURCE_STEP - 0.5
        row = (90 - lat) / SOURCE_STEP - 0.5
        valid = ~np.isnan(col)
        col = np.clip(np.nan_to_num(col), 0, columns - 1.001)
        row = np.clip(row, 0, rows - 1.001)
        c0, r0 = col.astype(int), row.astype(int)
        fc, fr = col - c0, row - r0
        top = source[r0, c0] * (1 - fc) + source[r0, c0 + 1] * fc
        bottom = source[r0 + 1, c0] * (1 - fc) + source[r0 + 1, c0 + 1] * fc
        out[start:stop] = np.where(valid, top * (1 - fr) + bottom * fr, 0)
    land = land_mask(width, height)
    flat = float(np.median(out[land]))
    encoded = np.where(land, out, flat)
    image = Image.fromarray(np.rint(encoded).astype(np.uint8), "L").convert("RGB")
    path = OUT / "hillshade.webp"
    image.save(path, "WEBP", quality=HILLSHADE_QUALITY, method=6)
    print(f"hillshade.webp: {width}x{height}, {path.stat().st_size / 1e6:.1f} MB")
    return {"width": width, "height": height, "flat": round(flat)}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    counts = build_lines()
    labels = build_labels()
    hillshade = build_hillshade()
    basemap = {"lines": counts, "hillshade": hillshade, **labels}
    (OUT / "basemap.json").write_text(
        json.dumps(basemap, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
    )
    print(f"basemap.json: {(OUT / 'basemap.json').stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()

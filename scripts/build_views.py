"""Build the conflict views: their settings, country icons and key events.

Reads   focus-events/<view>.csv                       key events, one file per view
        raw-data/revised-natural-earth/10m/...        country outlines for the icons
Writes  public/data/views.json

Each CSV has the columns name, description, start_date, end_date, latitude and
longitude, with dates as YYYY-MM-DD. Edit those files and run this script again to
update the key events.

Each view in views.json has:
  id, name      as below
  icon          an SVG path of the country's outline, in a box `width` by `height`
  center        [lon, lat] the map projects around, with Lambert's azimuthal
                equal-area projection
  bounds        [west, south, east, north] in degrees, which the view fits and
                won't zoom out past
  months        [first, last] as YYYY-MM, the months the timeline is locked to;
                a null last month runs to the end of the data
  conflicts     UCDP conflict names whose events the view shows, wherever they are
  countries     UCDP country names whose events the view shows, in its months
  events        the key events from the CSV, sorted by start date
"""
import csv
import json
import math
from pathlib import Path

import shapefile
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
NE = ROOT / "raw-data" / "revised-natural-earth" / "10m"
EVENTS = ROOT / "focus-events"
OUT = ROOT / "public" / "data" / "views.json"

VIEWS = [
    {
        "id": "ukraine",
        "name": "Ukraine",
        # Natural Earth's revised data puts Crimea and Sevastopol in Russia; the icon
        # shows Ukraine's internationally recognized borders.
        "outline": {"countries": ["Ukraine"], "provinces": ["Crimea", "Sevastopol"]},
        "center": [31.5, 48.4],
        "bounds": [22.0, 44.2, 40.5, 52.6],
        "months": ["2022-02", None],
        "conflicts": ["Russia - Ukraine"],
        "countries": [],
    },
    {
        "id": "afghanistan",
        "name": "Afghanistan",
        "outline": {"countries": ["Afghanistan"], "provinces": []},
        "center": [67.7, 33.9],
        "bounds": [60.4, 29.3, 75.0, 38.5],
        "months": ["2001-10", "2021-08"],
        "conflicts": [],
        "countries": ["Afghanistan"],
    },
    {
        "id": "syria",
        "name": "Syria",
        "outline": {"countries": ["Syria"], "provinces": []},
        "center": [38.9, 34.8],
        "bounds": [35.6, 32.2, 42.4, 37.4],
        "months": ["2011-03", "2024-12"],
        "conflicts": [],
        "countries": ["Syria"],
    },
]

# Icons fit a box this many units on their longer side, simplified to this share of it.
ICON_SIZE = 100
ICON_SIMPLIFY = 0.004
# Islands smaller than this share of the main outline's area drop out of icons.
ICON_MIN_PIECE = 0.002


def laea(lon, lat, center):
    """Lambert azimuthal equal-area on a unit sphere, around `center`."""
    lam0, phi0 = map(math.radians, center)
    lam, phi = math.radians(lon), math.radians(lat)
    cos_c = math.sin(phi0) * math.sin(phi) + math.cos(phi0) * math.cos(phi) * math.cos(lam - lam0)
    k = math.sqrt(2 / (1 + cos_c))
    x = k * math.cos(phi) * math.sin(lam - lam0)
    y = k * (math.cos(phi0) * math.sin(phi) - math.sin(phi0) * math.cos(phi) * math.cos(lam - lam0))
    return x, y


def read_shapes(layer, field, names):
    reader = shapefile.Reader(str(NE / layer / layer), encoding="utf-8")
    return [
        shape(record.shape.__geo_interface__)
        for record in reader.iterShapeRecords()
        if record.record.as_dict()[field] in names
    ]


def icon(view):
    outline = view["outline"]
    pieces = read_shapes("ne_10m_admin_0_countries", "ADMIN", outline["countries"])
    if outline["provinces"]:
        pieces += read_shapes("ne_10m_admin_1_states_provinces", "name", outline["provinces"])
    merged = unary_union([piece.buffer(0) for piece in pieces])
    polygons = list(merged.geoms) if isinstance(merged, MultiPolygon) else [merged]

    def project(polygon):
        ring = lambda coords: [laea(lon, lat, view["center"]) for lon, lat in coords]  # noqa: E731
        return Polygon(ring(polygon.exterior.coords))

    projected = [project(polygon) for polygon in polygons]
    largest = max(piece.area for piece in projected)
    projected = [piece for piece in projected if piece.area >= largest * ICON_MIN_PIECE]
    west, south, east, north = MultiPolygon(projected).bounds
    unit = ICON_SIZE / max(east - west, north - south)
    tolerance = ICON_SIMPLIFY * max(east - west, north - south)
    paths = []
    for piece in projected:
        ring = piece.simplify(tolerance).exterior.coords[:-1]
        points = [f"{(x - west) * unit:.1f} {(north - y) * unit:.1f}" for x, y in ring]
        paths.append("M" + "L".join(points) + "Z")
    return {
        "d": "".join(paths),
        "width": round((east - west) * unit, 1),
        "height": round((north - south) * unit, 1),
    }


def key_events(view):
    with open(EVENTS / f"{view['id']}.csv", encoding="utf-8", newline="") as file:
        rows = list(csv.DictReader(file))
    events = [
        {
            "name": row["name"].strip(),
            "description": row["description"].strip(),
            "start": row["start_date"].strip(),
            "end": (row["end_date"] or row["start_date"]).strip(),
            "lat": float(row["latitude"]),
            "lon": float(row["longitude"]),
        }
        for row in rows
        if row["name"].strip()
    ]
    return sorted(events, key=lambda event: (event["start"], event["end"]))


def main():
    views = []
    for view in VIEWS:
        settings = {key: view[key] for key in ["id", "name", "center", "bounds", "months", "conflicts", "countries"]}
        views.append({**settings, "icon": icon(view), "events": key_events(view)})
    OUT.write_text(json.dumps({"views": views}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for view in views:
        print(f"{view['id']}: {len(view['events'])} key events, icon {len(view['icon']['d'])} characters")


if __name__ == "__main__":
    main()

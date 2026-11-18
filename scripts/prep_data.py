"""Turn the UCDP GED event CSVs into the compact files the web app loads.

Reads   raw-data/GEDEvent_v26_1.csv          (final data, 1989-2025)
        raw-data/GEDEvent_v26_01_26_09.csv   (provisional candidate data, 2026)
Writes  public/data/events.bin, public/data/attrs.bin, public/data/meta.json

events.bin holds 12 bytes per event, little-endian, for the GPU:
  uint16 x       Equal Earth x, scaled from -xMax..xMax to 0..65535
  uint16 y       Equal Earth y, scaled from -yMax..yMax to 0..65535
  uint16 start   first day of the event, counted from 1989-01-01
  uint16 end     last day of the event, counted from 1989-01-01
  uint32 best    UCDP's best estimate of deaths

attrs.bin holds one array after another, in the same event order, for filtering:
  uint16 adm1[count]      first-level division id, 0 if none was recorded
  uint16 adm2[count]      second-level division id, 0 if none was recorded
  uint16 conflict[count]  conflict id
  uint16 sideA[count]     actor id of side A
  uint16 sideB[count]     actor id of side B
  uint8  country[count]   country id
  uint8  flags[count]     bit 0: provisional (from the candidate dataset)

Events are sorted by start day. Ids index the lists in meta.json; division
id 0 is a placeholder for "none".
"""
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw-data"
OUT = ROOT / "public" / "data"
SOURCES = [
    (RAW / "GEDEvent_v26_1.csv", False),
    (RAW / "GEDEvent_v26_01_26_09.csv", True),
]
COLUMNS = [
    "id", "conflict_name", "side_a", "side_b", "adm_1", "adm_2", "country", "region",
    "latitude", "longitude", "date_start", "date_end", "best",
]
EPOCH = pd.Timestamp("1989-01-01")
PROVISIONAL = 1

# Equal Earth (Šavrič, Patterson & Jenny, 2018).
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
M = math.sqrt(3) / 2


def equal_earth(lon_deg, lat_deg):
    lam = np.radians(lon_deg)
    theta = np.arcsin(M * np.sin(np.radians(lat_deg)))
    t2 = theta * theta
    t6 = t2 * t2 * t2
    x = lam * np.cos(theta) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)))
    y = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))
    return x, y


X_MAX = float(equal_earth(np.array([180.0]), np.array([0.0]))[0][0])
Y_MAX = float(equal_earth(np.array([0.0]), np.array([90.0]))[1][0])


def scale(values: np.ndarray, extent: float) -> np.ndarray:
    return np.rint((values + extent) / (2 * extent) * 65535).astype("<u2")


def ids_for(values: pd.Series) -> tuple[pd.Series, list[str]]:
    """Ids by name, alphabetical, from 0."""
    names = sorted(values.unique(), key=str.casefold)
    lookup = {name: index for index, name in enumerate(names)}
    return values.map(lookup), names


def month_starts(last_day: pd.Timestamp) -> list[pd.Timestamp]:
    end = (last_day + pd.offsets.MonthBegin(1)).normalize()
    return list(pd.date_range(EPOCH, end, freq="MS"))


def main():
    frames = []
    for path, provisional in SOURCES:
        frame = pd.read_csv(path, usecols=COLUMNS, keep_default_na=False, na_values=[""],
                            dtype={"adm_1": str, "adm_2": str})
        frame["flags"] = PROVISIONAL if provisional else 0
        frames.append(frame)
    events = pd.concat(frames, ignore_index=True)
    if events["id"].duplicated().any():
        raise ValueError("An event id appears in more than one source")
    for column in ["adm_1", "adm_2"]:
        events[column] = events[column].fillna("").str.strip()

    start = pd.to_datetime(events["date_start"])
    end = pd.to_datetime(events["date_end"])
    events["start"] = (start - EPOCH).dt.days
    events["end"] = (end - EPOCH).dt.days
    if (events["start"] < 0).any() or (events["end"] < events["start"]).any():
        raise ValueError("An event has dates out of order or before 1989")
    events = events.sort_values(["start", "id"], kind="stable").reset_index(drop=True)

    # Regions and countries. Every country belongs to exactly one region.
    region_ids, regions = ids_for(events["region"])
    events["region_id"] = region_ids
    country_ids, countries = ids_for(events["country"])
    events["country_id"] = country_ids
    country_regions = events.groupby("country_id")["region_id"].unique()
    if (country_regions.map(len) > 1).any():
        raise ValueError("A country is in more than one region")
    if len(countries) > 255:
        raise ValueError("Too many countries for one byte")

    # Divisions are named within their parent, so ids go to (parent, name) pairs.
    # Division id 0 means none was recorded.
    has_adm1 = events["adm_1"] != ""
    adm1_keys = events.loc[has_adm1, ["country_id", "adm_1"]].drop_duplicates()
    adm1_keys = adm1_keys.sort_values(["country_id", "adm_1"]).reset_index(drop=True)
    adm1_keys["adm1_id"] = adm1_keys.index + 1
    events = events.merge(adm1_keys, how="left", on=["country_id", "adm_1"])
    events["adm1_id"] = events["adm1_id"].fillna(0).astype("int64")

    has_adm2 = (events["adm_2"] != "") & (events["adm1_id"] > 0)
    adm2_keys = events.loc[has_adm2, ["adm1_id", "adm_2"]].drop_duplicates()
    adm2_keys = adm2_keys.sort_values(["adm1_id", "adm_2"]).reset_index(drop=True)
    adm2_keys["adm2_id"] = adm2_keys.index + 1
    events = events.merge(adm2_keys, how="left", on=["adm1_id", "adm_2"])
    events["adm2_id"] = events["adm2_id"].fillna(0).astype("int64")
    if len(adm2_keys) >= 1 << 16:
        raise ValueError("Too many second-level divisions for two bytes")

    # Actors share one list, so an actor has one id whichever side it's on.
    actors = sorted(pd.concat([events["side_a"], events["side_b"]]).unique(), key=str.casefold)
    actor_lookup = {name: index for index, name in enumerate(actors)}
    conflict_ids, conflicts = ids_for(events["conflict_name"])

    x, y = equal_earth(events["longitude"].to_numpy(), events["latitude"].to_numpy())
    records = np.empty(len(events), dtype=[("x", "<u2"), ("y", "<u2"), ("start", "<u2"),
                                           ("end", "<u2"), ("best", "<u4")])
    records["x"] = scale(x, X_MAX)
    records["y"] = scale(y, Y_MAX)
    records["start"] = events["start"]
    records["end"] = events["end"]
    records["best"] = events["best"]

    count = len(events)
    attrs = b"".join([
        events["adm1_id"].to_numpy("<u2").tobytes(),
        events["adm2_id"].to_numpy("<u2").tobytes(),
        conflict_ids.to_numpy("<u2").tobytes(),
        events["side_a"].map(actor_lookup).to_numpy("<u2").tobytes(),
        events["side_b"].map(actor_lookup).to_numpy("<u2").tobytes(),
        events["country_id"].to_numpy("<u1").tobytes(),
        events["flags"].to_numpy("<u1").tobytes(),
    ])

    last_day = EPOCH + pd.Timedelta(days=int(events["end"].max()))
    meta = {
        "count": count,
        "extent": {"xMax": X_MAX, "yMax": Y_MAX},
        "epoch": EPOCH.strftime("%Y-%m-%d"),
        # Month starts as days from the epoch, with one more for the end of the last month.
        "months": [
            {"day": (month - EPOCH).days, "year": month.year, "month": month.month}
            for month in month_starts(last_day)
        ],
        "regions": regions,
        "countries": [
            {"name": name, "region": int(country_regions[index][0])}
            for index, name in enumerate(countries)
        ],
        # Index 0 is the "none" placeholder.
        "adm1": [{"name": "", "country": -1}] + [
            {"name": row.adm_1, "country": int(row.country_id)} for row in adm1_keys.itertuples()
        ],
        "adm2": [{"name": "", "adm1": 0}] + [
            {"name": row.adm_2, "adm1": int(row.adm1_id)} for row in adm2_keys.itertuples()
        ],
        "actors": actors,
        "conflicts": conflicts,
    }

    OUT.mkdir(parents=True, exist_ok=True)
    records.tofile(OUT / "events.bin")
    (OUT / "attrs.bin").write_bytes(attrs)
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":"), ensure_ascii=False),
                                   encoding="utf-8")
    provisional = int((events["flags"] & PROVISIONAL).astype(bool).sum())
    print(f"{count:,} events ({provisional:,} provisional), {len(countries)} countries, "
          f"{len(adm1_keys):,} adm_1, {len(adm2_keys):,} adm_2, {len(actors):,} actors, "
          f"{len(conflicts):,} conflicts, days {events['start'].min()}-{events['end'].max()}")


if __name__ == "__main__":
    main()

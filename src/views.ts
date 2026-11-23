import type { Basemap, EventData, LineCounts, MapLabel, Meta } from "./data";
import { GRID_MAX } from "./selection";

/** A key event as views.json holds it, from the view's CSV. */
interface KeyEventSource {
  name: string;
  description: string;
  /** YYYY-MM-DD. */
  start: string;
  end: string;
  lat: number;
  lon: number;
}

/** A conflict view as views.json holds it. scripts/build_views.py describes each field. */
export interface ConflictView {
  id: string;
  name: string;
  icon: { d: string; width: number; height: number };
  center: [lon: number, lat: number];
  bounds: [west: number, south: number, east: number, north: number];
  months: [first: string, last: string | null];
  conflicts: string[];
  countries: string[];
  events: KeyEventSource[];
}

/** A key event ready to show: its days from the epoch, and its spot on the view's grid. */
export interface KeyEvent {
  name: string;
  description: string;
  start: number;
  /** The last day, included. */
  end: number;
  x: number;
  y: number;
  /** False when the spot lies off the view's map. */
  isOnMap: boolean;
}

/** Everything a conflict view swaps in: the events reprojected, which of them it shows, and more. */
export interface ProjectedView {
  view: ConflictView;
  data: EventData;
  /** 1 for each event the view shows: its conflicts' or countries' events in its months, on its map. */
  scope: Uint8Array;
  /** The months the timeline is locked to, as indexes into `meta.months`, the last one excluded. */
  months: [from: number, to: number];
  keyEvents: KeyEvent[];
  projectLines: (segments: Uint16Array, counts: LineCounts) => { segments: Uint16Array; counts: LineCounts };
  projectBasemap: (basemap: Basemap) => Basemap;
}

/** Loaded once, on the first visit to the view selector or a view. */
let views: Promise<ConflictView[]> | null = null;

export function loadViews(): Promise<ConflictView[]> {
  views ??= fetch(`${import.meta.env.BASE_URL}data/views.json`)
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load views.json (${response.status})`);
      return response.json() as Promise<{ views: ConflictView[] }>;
    })
    .then(({ views: list }) => list);
  views.catch(() => {
    views = null;
  });
  return views;
}

// Equal Earth, which the global grid uses, on a unit sphere.
const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;
const RADIANS = Math.PI / 180;

function equalEarth(lon: number, lat: number): [number, number] {
  const theta = Math.asin(M * Math.sin(lat * RADIANS));
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  const x = (lon * RADIANS * Math.cos(theta)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
  const y = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  return [x, y];
}

function inverseEqualEarth(x: number, y: number): [lon: number, lat: number] {
  let theta = y / A1;
  for (let step = 0; step < 5; step += 1) {
    const t2 = theta * theta;
    const t6 = t2 * t2 * t2;
    const f = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)) - y;
    theta -= f / (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2));
  }
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  const lon = (x * M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))) / Math.cos(theta);
  const lat = Math.asin(Math.sin(theta) / M);
  return [lon / RADIANS, lat / RADIANS];
}

/** Lambert's azimuthal equal-area projection on a unit sphere, around a center, and back. */
function azimuthal([lon0, lat0]: [number, number]) {
  const lam0 = lon0 * RADIANS;
  const sinPhi0 = Math.sin(lat0 * RADIANS);
  const cosPhi0 = Math.cos(lat0 * RADIANS);
  const forward = (lon: number, lat: number): [number, number] | null => {
    const lam = lon * RADIANS - lam0;
    const sinPhi = Math.sin(lat * RADIANS);
    const cosPhi = Math.cos(lat * RADIANS);
    const cosC = sinPhi0 * sinPhi + cosPhi0 * cosPhi * Math.cos(lam);
    // The far side of the globe has nowhere sensible to go.
    if (cosC < -0.5) return null;
    const k = Math.sqrt(2 / (1 + cosC));
    return [k * cosPhi * Math.sin(lam), k * (cosPhi0 * sinPhi - sinPhi0 * cosPhi * Math.cos(lam))];
  };
  const inverse = (x: number, y: number): [number, number] => {
    const rho = Math.hypot(x, y);
    if (rho === 0) return [lon0, lat0];
    const c = 2 * Math.asin(Math.min(1, rho / 2));
    const sinC = Math.sin(c);
    const cosC = Math.cos(c);
    const lat = Math.asin(cosC * sinPhi0 + (y * sinC * cosPhi0) / rho);
    const lon = lam0 + Math.atan2(x * sinC, rho * cosPhi0 * cosC - y * sinPhi0 * sinC);
    return [lon / RADIANS, lat / RADIANS];
  };
  return { forward, inverse };
}

// A view's map runs this many times the larger side of its bounds across and down, so
// the open part of a wide or tall window is filled however it's panned.
const EXTENT_PER_BOUNDS = 3;
// Bounds and extents are traced with this many points along each side.
const EDGE_STEPS = 32;

const MS_PER_DAY = 86_400_000;

/** Days from the epoch to a YYYY-MM-DD date. */
const dayOf = (epoch: string, date: string) =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${epoch}T00:00:00Z`)) / MS_PER_DAY);

/** A month, YYYY-MM, as an index into `meta.months`, or -1. */
const monthIndex = (meta: Meta, month: string) => {
  const [year, number] = month.split("-").map(Number);
  return meta.months.findIndex((entry) => entry.year === year && entry.month === number);
};

/** Points along a box's edges, for finding what it covers once projected. */
function edgePoints(west: number, south: number, east: number, north: number) {
  const points: [number, number][] = [];
  for (let step = 0; step <= EDGE_STEPS; step += 1) {
    const t = step / EDGE_STEPS;
    points.push([west + (east - west) * t, south], [west + (east - west) * t, north]);
    points.push([west, south + (north - south) * t], [east, south + (north - south) * t]);
  }
  return points;
}

/**
 * Reprojects the events, lines and labels from the world's Equal Earth grid onto a
 * grid for the view: an azimuthal equal-area map around its center, so its area
 * keeps true shapes and sizes.
 */
export function projectView(base: EventData, view: ConflictView): ProjectedView {
  const { meta } = base;
  const projection = azimuthal(view.center);

  // The bounds, projected, and the larger map around them.
  let [left, right, bottom, top] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [lon, lat] of edgePoints(...view.bounds)) {
    const [x, y] = projection.forward(lon, lat)!;
    left = Math.min(left, x);
    right = Math.max(right, x);
    bottom = Math.min(bottom, y);
    top = Math.max(top, y);
  }
  const middleX = (left + right) / 2;
  const middleY = (bottom + top) / 2;
  const half = (Math.max(right - left, top - bottom) * EXTENT_PER_BOUNDS) / 2;
  const share = (value: number, middle: number) => (value - middle + half) / (2 * half);
  const region = {
    west: share(left, middleX),
    east: share(right, middleX),
    south: share(bottom, middleY),
    north: share(top, middleY),
    world: meta.extent,
  };

  /** A spot in degrees on the view's grid, or null if it's off the map. */
  const toGrid = (lon: number, lat: number): [number, number] | null => {
    const projected = projection.forward(lon, lat);
    if (!projected) return null;
    const x = share(projected[0], middleX);
    const y = share(projected[1], middleY);
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return [Math.round(x * GRID_MAX), Math.round(y * GRID_MAX)];
  };
  const { xMax, yMax } = meta.extent;
  const fromWorldGrid = (x: number, y: number) =>
    toGrid(...inverseEqualEarth((x / GRID_MAX) * 2 * xMax - xMax, (y / GRID_MAX) * 2 * yMax - yMax));

  // The part of the world grid the view's map covers, to skip the rest quickly.
  let [worldWest, worldEast, worldSouth, worldNorth] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [x, y] of edgePoints(middleX - half, middleY - half, middleX + half, middleY + half)) {
    const [ex, ey] = equalEarth(...projection.inverse(x, y));
    worldWest = Math.min(worldWest, ((ex + xMax) / (2 * xMax)) * GRID_MAX);
    worldEast = Math.max(worldEast, ((ex + xMax) / (2 * xMax)) * GRID_MAX);
    worldSouth = Math.min(worldSouth, ((ey + yMax) / (2 * yMax)) * GRID_MAX);
    worldNorth = Math.max(worldNorth, ((ey + yMax) / (2 * yMax)) * GRID_MAX);
  }
  const isNear = (x: number, y: number) => x >= worldWest && x <= worldEast && y >= worldSouth && y <= worldNorth;

  // The months the view covers.
  const lastMonth = meta.months.length - 1;
  const firstIndex = Math.max(0, monthIndex(meta, view.months[0]));
  const lastIndex = view.months[1] === null ? lastMonth - 1 : monthIndex(meta, view.months[1]);
  const months: [number, number] = [firstIndex, (lastIndex < 0 ? lastMonth - 1 : lastIndex) + 1];
  const fromDay = meta.months[months[0]]!.day;
  const toDay = meta.months[months[1]]!.day;

  // Which events the view shows, and where they go on its grid.
  const conflicts = new Set(view.conflicts.map((name) => meta.conflicts.indexOf(name)));
  const countries = new Set(view.countries.map((name) => meta.countries.findIndex((country) => country.name === name)));
  const { count } = meta;
  const scope = new Uint8Array(count);
  const bytes = new Uint8Array(base.buffer.slice(0));
  const words = new Uint16Array(bytes.buffer);
  const x = new Uint16Array(count);
  const y = new Uint16Array(count);
  const { conflict, country } = base.attrs;
  for (let index = 0; index < count; index += 1) {
    const at = index * 6;
    words[at] = 0;
    words[at + 1] = 0;
    const isOurs = conflicts.has(conflict[index]!) || countries.has(country[index]!);
    if (!isOurs || base.start[index]! >= toDay || base.end[index]! < fromDay) continue;
    const spot = fromWorldGrid(base.x[index]!, base.y[index]!);
    if (!spot) continue;
    scope[index] = 1;
    x[index] = words[at] = spot[0];
    y[index] = words[at + 1] = spot[1];
  }

  const data: EventData = {
    ...base,
    meta: { ...meta, extent: { xMax: half, yMax: half }, region },
    buffer: bytes.buffer,
    x,
    y,
  };

  const keyEvents = view.events.map((event) => {
    const spot = toGrid(event.lon, event.lat);
    return {
      name: event.name,
      description: event.description,
      start: dayOf(meta.epoch, event.start),
      end: dayOf(meta.epoch, event.end),
      x: spot?.[0] ?? 0,
      y: spot?.[1] ?? 0,
      isOnMap: spot !== null,
    };
  });

  const projectLines = (segments: Uint16Array, counts: LineCounts) => {
    const kept = new Uint16Array(segments.length);
    const keptCounts: LineCounts = { coast: 0, border: 0, province: 0 };
    let written = 0;
    let segment = 0;
    for (const kind of ["coast", "border", "province"] as const) {
      for (let end = segment + counts[kind]; segment < end; segment += 1) {
        const at = segment * 4;
        if (!isNear(segments[at]!, segments[at + 1]!) && !isNear(segments[at + 2]!, segments[at + 3]!)) continue;
        const from = fromWorldGrid(segments[at]!, segments[at + 1]!);
        const to = from && fromWorldGrid(segments[at + 2]!, segments[at + 3]!);
        if (!from || !to) continue;
        kept.set([from[0], from[1], to[0], to[1]], written);
        written += 4;
        keptCounts[kind] += 1;
      }
    }
    return { segments: kept.slice(0, written), counts: keptCounts };
  };

  const projectLabels = <T extends MapLabel>(labels: T[]) =>
    labels.flatMap((label) => {
      const spot = isNear(label.x, label.y) && fromWorldGrid(label.x, label.y);
      return spot ? [{ ...label, x: spot[0], y: spot[1] }] : [];
    });
  const projectBasemap = (basemap: Basemap): Basemap => ({
    ...basemap,
    countries: projectLabels(basemap.countries),
    provinces: projectLabels(basemap.provinces),
    places: projectLabels(basemap.places),
  });

  return { view, data, scope, months, keyEvents, projectLines, projectBasemap };
}

import { VIOLENCE_TYPES, type Details, type EventData } from "./data";
import { ALL, type ListFilter, type LocationFilter } from "./filters";

/** Positions are stored as 16-bit integers across the projection's extent. */
export const GRID_MAX = 65535;

/** A box on the map, in grid units. */
export interface Area {
  west: number;
  east: number;
  south: number;
  north: number;
}

export const WHOLE_WORLD: Area = { west: 0, east: GRID_MAX, south: 0, north: GRID_MAX };

/** Days from the epoch: events that overlap `from` up to, but not including, `to`. */
export interface DayWindow {
  from: number;
  to: number;
}

export interface Filters {
  location: LocationFilter;
  actor: ListFilter;
  conflict: ListFilter;
  /** The type of violence, by its UCDP code. */
  type: ListFilter;
}

type Test = (index: number) => boolean;
const always: Test = () => true;

function locationTest({ attrs, meta }: EventData, { level, id }: LocationFilter): Test {
  const { country, adm1, adm2 } = attrs;
  if (level === "region") {
    const inRegion = Uint8Array.from(meta.countries, ({ region }) => (region === id ? 1 : 0));
    return (index) => inRegion[country[index]!] === 1;
  }
  if (level === "country") return (index) => country[index] === id;
  if (level === "adm1") return (index) => adm1[index] === id;
  if (level === "adm2") return (index) => adm2[index] === id;
  return always;
}

function actorTest({ attrs }: EventData, { id }: ListFilter): Test {
  if (id === ALL) return always;
  const { sideA, sideB } = attrs;
  return (index) => sideA[index] === id || sideB[index] === id;
}

function conflictTest({ attrs }: EventData, { id }: ListFilter): Test {
  if (id === ALL) return always;
  const { conflict } = attrs;
  return (index) => conflict[index] === id;
}

function typeTest({ attrs }: EventData, { id }: ListFilter): Test {
  if (id === ALL) return always;
  const { type } = attrs;
  return (index) => type[index] === id;
}

/** Tests for every filter but `skip`, so a menu can count what each of its items would show. */
function filterTests(data: EventData, filters: Filters, skip?: keyof Filters): Test[] {
  const tests: [keyof Filters, Test][] = [
    ["location", locationTest(data, filters.location)],
    ["actor", actorTest(data, filters.actor)],
    ["conflict", conflictTest(data, filters.conflict)],
    ["type", typeTest(data, filters.type)],
  ];
  return tests.filter(([key]) => key !== skip).map(([, test]) => test);
}

function areaTest({ x, y }: EventData, area: Area): Test {
  if (area === WHOLE_WORLD) return always;
  const { west, east, south, north } = area;
  return (index) => {
    const px = x[index]!;
    const py = y[index]!;
    return px >= west && px <= east && py >= south && py <= north;
  };
}

/** 1 for each event that passes the location, actor, conflict and type filters. The GPU draws only these. */
export function filterEvents(data: EventData, filters: Filters) {
  const tests = filterTests(data, filters);
  const visible = new Uint8Array(data.meta.count);
  let count = 0;
  for (let index = 0; index < visible.length; index += 1) {
    if (tests.every((test) => test(index))) {
      visible[index] = 1;
      count += 1;
    }
  }
  return { visible, count };
}

/** A death toll: the best estimate, and the low and high ones once they've loaded. */
export interface Toll {
  best: number;
  low: number;
  high: number;
}

/**
 * Events and deaths among the filtered events inside the box and dates, and the
 * filtered events in the dates wherever they are, which sets the points' brightness.
 */
export function totals(
  data: EventData,
  details: Details | null,
  visible: Uint8Array,
  area: Area,
  { from, to }: DayWindow,
) {
  const { start, end, best } = data;
  const inArea = areaTest(data, area);
  let events = 0;
  let shown = 0;
  const fatalities: Toll = { best: 0, low: 0, high: 0 };
  for (let index = 0; index < visible.length; index += 1) {
    if (!visible[index] || start[index]! >= to || end[index]! < from) continue;
    shown += 1;
    if (inArea(index)) {
      events += 1;
      fatalities.best += best[index]!;
      if (details) {
        fatalities.low += details.low[index]!;
        fatalities.high += details.high[index]!;
      }
    }
  }
  return { events, fatalities, shown };
}

/** Each day's month, by index into `meta.months`. */
export function monthOfDay({ months }: EventData["meta"]) {
  const days = new Uint16Array(months.at(-1)!.day);
  for (let month = 0; month < months.length - 1; month += 1) {
    days.fill(month, months[month]!.day, months[month + 1]!.day);
  }
  return days;
}

/**
 * Deaths among the filtered events inside the box, by month. An event that runs
 * through several months has its deaths shared among them by how many of its days
 * fall in each.
 */
export function fatalitiesByMonth(
  data: EventData,
  visible: Uint8Array,
  area: Area,
  monthOf: Uint16Array,
  best: Uint32Array = data.best,
  /** Only events of this type of violence, if given. */
  onlyType = 0,
) {
  const { type } = data.attrs;
  const { start, end } = data;
  const { months } = data.meta;
  const totals = new Float64Array(months.length - 1);
  const inArea = areaTest(data, area);
  for (let index = 0; index < visible.length; index += 1) {
    const deaths = best[index]!;
    if (!visible[index] || deaths === 0 || (onlyType && type[index] !== onlyType) || !inArea(index)) continue;
    const first = start[index]!;
    const last = end[index]!;
    const firstMonth = monthOf[first]!;
    const lastMonth = monthOf[last]!;
    if (firstMonth === lastMonth) {
      totals[firstMonth]! += deaths;
      continue;
    }
    const perDay = deaths / (last - first + 1);
    for (let month = firstMonth; month <= lastMonth; month += 1) {
      const from = Math.max(first, months[month]!.day);
      const to = Math.min(last + 1, months[month + 1]!.day);
      totals[month]! += perDay * (to - from);
    }
  }
  return totals;
}

/** What a menu item would show: how many events, and their deaths. */
export interface MenuCounts<T> {
  events: (value: T) => number;
  fatalities: (value: T) => number;
  low: (value: T) => number;
  high: (value: T) => number;
}

type TollField = "fatalities" | "low" | "high";

/** Runs `add` for each event in the dates and box that passes every test. */
function eachEvent(
  data: EventData,
  tests: Test[],
  area: Area,
  { from, to }: DayWindow,
  add: (index: number) => void,
) {
  const { start, end } = data;
  const all = [...tests, areaTest(data, area)];
  for (let index = 0; index < data.meta.count; index += 1) {
    if (start[index]! < to && end[index]! >= from && all.every((test) => test(index))) add(index);
  }
}

/** Event and death tallies, one slot per id, plus a total. */
class Tally {
  events: Uint32Array;
  fatalities: Float64Array;
  low: Float64Array;
  high: Float64Array;
  totals = { events: 0, fatalities: 0, low: 0, high: 0 };

  constructor(
    size: number,
    private data: EventData,
    private details: Details | null,
  ) {
    this.events = new Uint32Array(size);
    this.fatalities = new Float64Array(size);
    this.low = new Float64Array(size);
    this.high = new Float64Array(size);
  }

  /** Counts an event toward an id. */
  add(id: number, index: number) {
    this.events[id]! += 1;
    this.fatalities[id]! += this.data.best[index]!;
    if (!this.details) return;
    this.low[id]! += this.details.low[index]!;
    this.high[id]! += this.details.high[index]!;
  }

  addTotal(index: number) {
    const { totals } = this;
    totals.events += 1;
    totals.fatalities += this.data.best[index]!;
    if (!this.details) return;
    totals.low += this.details.low[index]!;
    totals.high += this.details.high[index]!;
  }

  read(field: "events" | TollField, id: number | null) {
    return id === null ? this.totals[field] : this[field][id]!;
  }
}

/** What each location menu item would show, given the other filters. */
export function countLocations(
  data: EventData,
  details: Details | null,
  filters: Filters,
  area: Area,
  window: DayWindow,
): MenuCounts<LocationFilter> {
  const { meta, attrs } = data;
  const tallies = {
    region: new Tally(meta.regions.length, data, details),
    country: new Tally(meta.countries.length, data, details),
    adm1: new Tally(meta.adm1.length, data, details),
    adm2: new Tally(meta.adm2.length, data, details),
  };
  const regionOf = meta.countries.map(({ region }) => region);
  const tests = filterTests(data, filters, "location");
  eachEvent(data, tests, area, window, (index) => {
    const country = attrs.country[index]!;
    tallies.region.addTotal(index);
    tallies.country.add(country, index);
    tallies.region.add(regionOf[country]!, index);
    tallies.adm1.add(attrs.adm1[index]!, index);
    tallies.adm2.add(attrs.adm2[index]!, index);
  });
  const read = (field: "events" | TollField) => ({ level, id }: LocationFilter) =>
    level === "all" ? tallies.region.read(field, null) : tallies[level].read(field, id);
  return { events: read("events"), fatalities: read("fatalities"), low: read("low"), high: read("high") };
}

function readList(tally: Tally): MenuCounts<ListFilter> {
  const read = (field: "events" | TollField) => ({ id }: ListFilter) =>
    tally.read(field, id === ALL ? null : id);
  return { events: read("events"), fatalities: read("fatalities"), low: read("low"), high: read("high") };
}

/** What each actor would show, given the other filters. An event counts toward both its sides. */
export function countActors(
  data: EventData,
  details: Details | null,
  filters: Filters,
  area: Area,
  window: DayWindow,
) {
  const { sideA, sideB } = data.attrs;
  const tally = new Tally(data.meta.actors.length, data, details);
  const tests = filterTests(data, filters, "actor");
  eachEvent(data, tests, area, window, (index) => {
    tally.addTotal(index);
    tally.add(sideA[index]!, index);
    if (sideB[index] !== sideA[index]) tally.add(sideB[index]!, index);
  });
  return readList(tally);
}

/** What each conflict would show, given the other filters. */
export function countConflicts(
  data: EventData,
  details: Details | null,
  filters: Filters,
  area: Area,
  window: DayWindow,
) {
  const tally = new Tally(data.meta.conflicts.length, data, details);
  const tests = filterTests(data, filters, "conflict");
  eachEvent(data, tests, area, window, (index) => {
    tally.addTotal(index);
    tally.add(data.attrs.conflict[index]!, index);
  });
  return readList(tally);
}

/** What each type of violence would show, given the other filters. */
export function countTypes(
  data: EventData,
  details: Details | null,
  filters: Filters,
  area: Area,
  window: DayWindow,
) {
  const tally = new Tally(VIOLENCE_TYPES.length + 1, data, details);
  const tests = filterTests(data, filters, "type");
  eachEvent(data, tests, area, window, (index) => {
    tally.addTotal(index);
    tally.add(data.attrs.type[index]!, index);
  });
  return readList(tally);
}

// Bounds leave out this share of events at each edge, so a stray event far away
// doesn't stretch them.
const BOUNDS_TRIM = 0.005;
const BOUNDS_BINS = 1024;

/** Where most of the filtered events sit, in grid units, or null if there are none. */
export function filteredBounds({ x, y }: EventData, visible: Uint8Array, count: number): Area | null {
  if (count === 0) return null;
  const binsX = new Uint32Array(BOUNDS_BINS);
  const binsY = new Uint32Array(BOUNDS_BINS);
  const binOf = (value: number) => Math.min(BOUNDS_BINS - 1, Math.floor((value / GRID_MAX) * BOUNDS_BINS));
  for (let index = 0; index < visible.length; index += 1) {
    if (!visible[index]) continue;
    binsX[binOf(x[index]!)]! += 1;
    binsY[binOf(y[index]!)]! += 1;
  }
  const skip = Math.floor(count * BOUNDS_TRIM);
  const edges = (bins: Uint32Array) => {
    let low = 0;
    for (let seen = 0; seen + bins[low]! <= skip; low += 1) seen += bins[low]!;
    let high = BOUNDS_BINS - 1;
    for (let seen = 0; seen + bins[high]! <= skip; high -= 1) seen += bins[high]!;
    const toGrid = (bin: number) => Math.round((bin / BOUNDS_BINS) * GRID_MAX);
    return [toGrid(low), toGrid(high + 1)] as const;
  };
  const [west, east] = edges(binsX);
  const [south, north] = edges(binsY);
  return { west, east, south, north };
}

/** The first and last day of the filtered events, or null if there are none. */
export function filteredDays({ start, end }: EventData, visible: Uint8Array): DayWindow | null {
  let from = Infinity;
  let to = -Infinity;
  for (let index = 0; index < visible.length; index += 1) {
    if (!visible[index]) continue;
    from = Math.min(from, start[index]!);
    to = Math.max(to, end[index]! + 1);
  }
  return from === Infinity ? null : { from, to };
}

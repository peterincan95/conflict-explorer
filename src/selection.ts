import type { EventData } from "./data";
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

function areaTest({ x, y }: EventData, area: Area): Test {
  if (area === WHOLE_WORLD) return always;
  const { west, east, south, north } = area;
  return (index) => {
    const px = x[index]!;
    const py = y[index]!;
    return px >= west && px <= east && py >= south && py <= north;
  };
}

/** 1 for each event that passes the location, actor and conflict filters. The GPU draws only these. */
export function filterEvents(data: EventData, { location, actor, conflict }: Filters) {
  const tests = [locationTest(data, location), actorTest(data, actor), conflictTest(data, conflict)];
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

/**
 * Events and fatalities among the filtered events inside the box and dates, and the
 * filtered events in the dates wherever they are, which sets the points' brightness.
 */
export function totals(data: EventData, visible: Uint8Array, area: Area, { from, to }: DayWindow) {
  const { start, end, best } = data;
  const inArea = areaTest(data, area);
  let events = 0;
  let fatalities = 0;
  let shown = 0;
  for (let index = 0; index < visible.length; index += 1) {
    if (!visible[index] || start[index]! >= to || end[index]! < from) continue;
    shown += 1;
    if (inArea(index)) {
      events += 1;
      fatalities += best[index]!;
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
) {
  const { start, end, best } = data;
  const { months } = data.meta;
  const totals = new Float64Array(months.length - 1);
  const inArea = areaTest(data, area);
  for (let index = 0; index < visible.length; index += 1) {
    const deaths = best[index]!;
    if (!visible[index] || deaths === 0 || !inArea(index)) continue;
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
}

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
  totalEvents = 0;
  totalFatalities = 0;

  constructor(size: number) {
    this.events = new Uint32Array(size);
    this.fatalities = new Float64Array(size);
  }

  add(id: number, deaths: number) {
    this.events[id]! += 1;
    this.fatalities[id]! += deaths;
  }

  addTotal(deaths: number) {
    this.totalEvents += 1;
    this.totalFatalities += deaths;
  }
}

/** What each location menu item would show, given the other filters. */
export function countLocations(
  data: EventData,
  filters: Filters,
  area: Area,
  window: DayWindow,
): MenuCounts<LocationFilter> {
  const { meta, attrs, best } = data;
  const tallies = {
    region: new Tally(meta.regions.length),
    country: new Tally(meta.countries.length),
    adm1: new Tally(meta.adm1.length),
    adm2: new Tally(meta.adm2.length),
  };
  const regionOf = meta.countries.map(({ region }) => region);
  const tests = [actorTest(data, filters.actor), conflictTest(data, filters.conflict)];
  eachEvent(data, tests, area, window, (index) => {
    const deaths = best[index]!;
    const country = attrs.country[index]!;
    tallies.region.addTotal(deaths);
    tallies.country.add(country, deaths);
    tallies.region.add(regionOf[country]!, deaths);
    tallies.adm1.add(attrs.adm1[index]!, deaths);
    tallies.adm2.add(attrs.adm2[index]!, deaths);
  });
  const read = (field: "events" | "fatalities") => ({ level, id }: LocationFilter) => {
    if (level === "all") {
      const tally = tallies.region;
      return field === "events" ? tally.totalEvents : tally.totalFatalities;
    }
    return tallies[level][field][id]!;
  };
  return { events: read("events"), fatalities: read("fatalities") };
}

function readList(tally: Tally): MenuCounts<ListFilter> {
  return {
    events: ({ id }) => (id === ALL ? tally.totalEvents : tally.events[id]!),
    fatalities: ({ id }) => (id === ALL ? tally.totalFatalities : tally.fatalities[id]!),
  };
}

/** What each actor would show, given the other filters. */
export function countActors(data: EventData, filters: Filters, area: Area, window: DayWindow) {
  const { attrs, best } = data;
  const { sideA, sideB } = attrs;
  const tally = new Tally(data.meta.actors.length);
  const tests = [locationTest(data, filters.location), conflictTest(data, filters.conflict)];
  eachEvent(data, tests, area, window, (index) => {
    const deaths = best[index]!;
    tally.addTotal(deaths);
    tally.add(sideA[index]!, deaths);
    if (sideB[index] !== sideA[index]) tally.add(sideB[index]!, deaths);
  });
  return readList(tally);
}

/** What each conflict would show, given the other filters. */
export function countConflicts(data: EventData, filters: Filters, area: Area, window: DayWindow) {
  const { attrs, best } = data;
  const tally = new Tally(data.meta.conflicts.length);
  const tests = [locationTest(data, filters.location), actorTest(data, filters.actor)];
  eachEvent(data, tests, area, window, (index) => {
    const deaths = best[index]!;
    tally.addTotal(deaths);
    tally.add(attrs.conflict[index]!, deaths);
  });
  return readList(tally);
}

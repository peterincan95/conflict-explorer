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

/** Filtered events inside the box in each month. An event counts in every month it runs through. */
export function countByMonth(
  data: EventData,
  visible: Uint8Array,
  area: Area,
  monthOf: Uint16Array,
) {
  const { start, end } = data;
  const counts = new Uint32Array(data.meta.months.length - 1);
  const inArea = areaTest(data, area);
  for (let index = 0; index < visible.length; index += 1) {
    if (!visible[index] || !inArea(index)) continue;
    const last = monthOf[end[index]!]!;
    for (let month = monthOf[start[index]!]!; month <= last; month += 1) counts[month]! += 1;
  }
  return counts;
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

/** How many events each location menu item would show, given the other filters. */
export function countLocations(data: EventData, filters: Filters, area: Area, window: DayWindow) {
  const { meta, attrs } = data;
  const regions = new Uint32Array(meta.regions.length);
  const countries = new Uint32Array(meta.countries.length);
  const adm1 = new Uint32Array(meta.adm1.length);
  const adm2 = new Uint32Array(meta.adm2.length);
  const regionOf = meta.countries.map(({ region }) => region);
  let total = 0;
  eachEvent(data, [actorTest(data, filters.actor), conflictTest(data, filters.conflict)], area, window, (index) => {
    const country = attrs.country[index]!;
    total += 1;
    countries[country]! += 1;
    regions[regionOf[country]!]! += 1;
    adm1[attrs.adm1[index]!]! += 1;
    adm2[attrs.adm2[index]!]! += 1;
  });
  return ({ level, id }: LocationFilter) => {
    if (level === "region") return regions[id]!;
    if (level === "country") return countries[id]!;
    if (level === "adm1") return adm1[id]!;
    if (level === "adm2") return adm2[id]!;
    return total;
  };
}

/** How many events each actor would show, given the other filters. */
export function countActors(data: EventData, filters: Filters, area: Area, window: DayWindow) {
  const { sideA, sideB } = data.attrs;
  const counts = new Uint32Array(data.meta.actors.length);
  let total = 0;
  eachEvent(data, [locationTest(data, filters.location), conflictTest(data, filters.conflict)], area, window, (index) => {
    total += 1;
    counts[sideA[index]!]! += 1;
    if (sideB[index] !== sideA[index]) counts[sideB[index]!]! += 1;
  });
  return ({ id }: ListFilter) => (id === ALL ? total : counts[id]!);
}

/** How many events each conflict would show, given the other filters. */
export function countConflicts(data: EventData, filters: Filters, area: Area, window: DayWindow) {
  const { conflict } = data.attrs;
  const counts = new Uint32Array(data.meta.conflicts.length);
  let total = 0;
  eachEvent(data, [locationTest(data, filters.location), actorTest(data, filters.actor)], area, window, (index) => {
    total += 1;
    counts[conflict[index]!]! += 1;
  });
  return ({ id }: ListFilter) => (id === ALL ? total : counts[id]!);
}

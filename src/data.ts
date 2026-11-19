/** Bytes per event in events.bin, as written by scripts/prep_data.py. */
export const BYTES_PER_EVENT = 12;
// attrs.bin: five uint16 arrays, then three uint8 arrays.
const ATTR_BYTES_PER_EVENT = 13;

export const PROVISIONAL_FLAG = 1;

/** UCDP's types of violence, by their code in the data. */
export const VIOLENCE_TYPES = [1, 2, 3] as const;
export type ViolenceType = (typeof VIOLENCE_TYPES)[number];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const monthName = (month: number) => MONTH_NAMES[month - 1]!;

const MS_PER_DAY = 86_400_000;

const dateOf = (epoch: string, day: number) =>
  new Date(Date.parse(`${epoch}T00:00:00Z`) + day * MS_PER_DAY);

/**
 * Days from the epoch, first to last, as "Dec 10, 2022", "Dec 10–14, 2022",
 * "Nov 28 – Dec 2, 2022" or "Dec 30, 2022 – Jan 2, 2023", sharing what they can.
 */
export function formatDays(epoch: string, first: number, last: number) {
  const parts = (day: number) => {
    const date = dateOf(epoch, day);
    return [monthName(date.getUTCMonth() + 1), date.getUTCDate(), date.getUTCFullYear()] as const;
  };
  const [monthA, dayA, yearA] = parts(first);
  const [monthB, dayB, yearB] = parts(last);
  if (first === last) return `${monthA} ${dayA}, ${yearA}`;
  if (yearA !== yearB) return `${monthA} ${dayA}, ${yearA} – ${monthB} ${dayB}, ${yearB}`;
  if (monthA !== monthB) return `${monthA} ${dayA} – ${monthB} ${dayB}, ${yearB}`;
  return `${monthA} ${dayA}–${dayB}, ${yearB}`;
}

export interface Month {
  /** Days from the epoch to the month's first day. */
  day: number;
  year: number;
  month: number;
}

export interface Meta {
  count: number;
  /** Equal Earth's extent, in projected units either side of zero. */
  extent: { xMax: number; yMax: number };
  epoch: string;
  /** Every month's start, plus one more for the end of the last month. */
  months: Month[];
  regions: string[];
  countries: { name: string; region: number }[];
  /** Entry 0 is a placeholder for events with no first-level division. */
  adm1: { name: string; country: number }[];
  /** Entry 0 is a placeholder for events with no second-level division. */
  adm2: { name: string; adm1: number }[];
  actors: string[];
  conflicts: string[];
  /** Events per source citation file. */
  sourceChunk: number;
}

/** Per-event attributes for filtering on the CPU. */
export interface Attributes {
  adm1: Uint16Array;
  adm2: Uint16Array;
  conflict: Uint16Array;
  sideA: Uint16Array;
  sideB: Uint16Array;
  country: Uint8Array;
  flags: Uint8Array;
  /** Type of violence: 1 state-based, 2 non-state, 3 one-sided. */
  type: Uint8Array;
}

export interface EventData {
  meta: Meta;
  /** Each event's record, for the GPU. */
  buffer: ArrayBuffer;
  x: Uint16Array;
  y: Uint16Array;
  start: Uint16Array;
  end: Uint16Array;
  best: Uint32Array;
  attrs: Attributes;
}

async function fetchOk(path: string): Promise<Response> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${path}`);
  if (!response.ok || !response.body) {
    throw new Error(`Could not load ${path} (${response.status})`);
  }
  return response;
}

async function readInto(path: string, bytes: Uint8Array, onBytes: (count: number) => void) {
  const reader = (await fetchOk(path)).body!.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > bytes.length) {
      throw new Error(`${path} is larger than meta.json describes`);
    }
    bytes.set(value, received);
    received += value.length;
    onBytes(value.length);
  }
  if (received !== bytes.length) {
    throw new Error(`${path} is smaller than meta.json describes`);
  }
}

/** Splits the interleaved records into one array per field, for quick passes on the CPU. */
function splitRecords(buffer: ArrayBuffer, count: number) {
  const words16 = new Uint16Array(buffer);
  const words32 = new Uint32Array(buffer);
  const x = new Uint16Array(count);
  const y = new Uint16Array(count);
  const start = new Uint16Array(count);
  const end = new Uint16Array(count);
  const best = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    const at = index * 6;
    x[index] = words16[at]!;
    y[index] = words16[at + 1]!;
    start[index] = words16[at + 2]!;
    end[index] = words16[at + 3]!;
    best[index] = words32[index * 3 + 2]!;
  }
  return { x, y, start, end, best };
}

export async function loadEvents(onProgress: (fraction: number) => void): Promise<EventData> {
  const meta: Meta = await (await fetchOk("meta.json")).json();
  const { count } = meta;
  const events = new Uint8Array(count * BYTES_PER_EVENT);
  const attrBytes = new Uint8Array(count * ATTR_BYTES_PER_EVENT);

  let received = 0;
  const onBytes = (bytes: number) => {
    received += bytes;
    onProgress(received / (events.length + attrBytes.length));
  };
  await Promise.all([
    readInto("events.bin", events, onBytes),
    readInto("attrs.bin", attrBytes, onBytes),
  ]);

  const { buffer } = attrBytes;
  const u16 = (index: number) => new Uint16Array(buffer, index * count * 2, count);
  const attrs: Attributes = {
    adm1: u16(0),
    adm2: u16(1),
    conflict: u16(2),
    sideA: u16(3),
    sideB: u16(4),
    country: new Uint8Array(buffer, count * 10, count),
    flags: new Uint8Array(buffer, count * 11, count),
    type: new Uint8Array(buffer, count * 12, count),
  };
  return { meta, buffer: events.buffer, ...splitRecords(events.buffer, count), attrs };
}

/** The basemap's two levels of line detail: for the zoomed-out map, and for closer in. */
export type LineDetail = "coarse" | "fine";

/** How many segments of each kind a lines file holds, in this order. */
export interface LineCounts {
  coast: number;
  border: number;
  province: number;
}

const LINE_FILES: Record<LineDetail, { file: string; key: string }> = {
  coarse: { file: "lines-50m.bin", key: "50m" },
  fine: { file: "lines-10m.bin", key: "10m" },
};

/** Basemap lines as segment endpoints on the events' grid, with how many of each kind. */
export async function loadLines(detail: LineDetail, basemap: Basemap) {
  const { file, key } = LINE_FILES[detail];
  const segments = new Uint16Array(await (await fetchOk(file)).arrayBuffer());
  return { segments, counts: basemap.lines[key]! };
}

/** The hillshade image, decoded off the main thread where the browser can. */
export async function loadHillshade(): Promise<ImageBitmap> {
  const blob = await (await fetchOk("hillshade.webp")).blob();
  return createImageBitmap(blob);
}

const sourceFiles = new Map<number, Promise<ExtrasEntry[]>>();

/** An event's source citation and its best estimate split by who died. */
export interface EventExtras {
  source: string;
  /** Deaths on side A, side B, among civilians, and of people unknown, adding up to the best. */
  deaths: [sideA: number, sideB: number, civilians: number, unknown: number];
}

type ExtrasEntry = [string, number, number, number, number];

/**
 * An event's source citation and deaths by side, fetched with the rest of its file
 * the first time any of them is needed.
 */
export async function loadExtras(meta: Meta, index: number): Promise<EventExtras> {
  const chunk = Math.floor(index / meta.sourceChunk);
  let file = sourceFiles.get(chunk);
  if (!file) {
    file = fetchOk(`sources/${chunk}.json`).then((response) => response.json() as Promise<ExtrasEntry[]>);
    // A failed fetch can be tried again later.
    file.catch(() => sourceFiles.delete(chunk));
    sourceFiles.set(chunk, file);
  }
  const [source, ...deaths] = (await file)[index % meta.sourceChunk] ?? ["", 0, 0, 0, 0];
  return { source, deaths: deaths as EventExtras["deaths"] };
}

/** Each event's low and high death estimates and place name, which only totals and the list need. */
export interface Details {
  low: Uint32Array;
  high: Uint32Array;
  place: Uint32Array;
  places: string[];
}

/** Loaded after the events, since the map works without them. */
export async function loadDetails(count: number): Promise<Details> {
  const [buffer, places] = await Promise.all([
    fetchOk("details.bin").then((response) => response.arrayBuffer()),
    fetchOk("places.json").then((response) => response.json() as Promise<string[]>),
  ]);
  if (buffer.byteLength !== count * 12) throw new Error("details.bin doesn't match meta.json");
  const u32 = (index: number) => new Uint32Array(buffer, index * count * 4, count);
  return { low: u32(0), high: u32(1), place: u32(2), places };
}

/** A label's spot on the events' grid. */
export interface MapLabel {
  name: string;
  x: number;
  y: number;
  /** The web map zoom where the label first shows, from Natural Earth's ranks. */
  minZoom: number;
}

export interface PlaceLabel extends MapLabel {
  capital: boolean;
}

/** What the basemap needs besides its lines and image. Labels come most important first. */
export interface Basemap {
  lines: Record<string, LineCounts>;
  /** `flat` is the gray of flat ground and water in the image, out of 255. */
  hillshade: { width: number; height: number; flat: number };
  countries: MapLabel[];
  provinces: MapLabel[];
  places: PlaceLabel[];
}

/** Loaded after the events, since the map works without it. */
export async function loadBasemap(): Promise<Basemap> {
  return (await fetchOk("basemap.json")).json();
}

/** Bytes per event in events.bin, as written by scripts/prep_data.py. */
export const BYTES_PER_EVENT = 12;
// attrs.bin: five uint16 arrays, then two uint8 arrays.
const ATTR_BYTES_PER_EVENT = 12;

export const PROVISIONAL_FLAG = 1;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const monthName = (month: number) => MONTH_NAMES[month - 1]!;

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
  };
  return { meta, buffer: events.buffer, ...splitRecords(events.buffer, count), attrs };
}

/** Country outlines as segment endpoints on the events' grid. Loaded after the events, since the map works without them. */
export async function loadOutlines(): Promise<Uint16Array> {
  return new Uint16Array(await (await fetchOk("outlines.bin")).arrayBuffer());
}

/** A country's label spot on the events' grid. */
export interface CountryLabel {
  name: string;
  x: number;
  y: number;
  /** The web map zoom where Natural Earth suggests the label first appears. */
  minZoom: number;
}

/** Country labels, most important first. Loaded after the events, like the outlines. */
export async function loadLabels(): Promise<CountryLabel[]> {
  return (await fetchOk("labels.json")).json();
}

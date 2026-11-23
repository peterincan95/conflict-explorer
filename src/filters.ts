import type { MenuItem } from "./ColumnMenu";
import { COPY } from "./copy";
import { VIOLENCE_TYPES, type EventData, type Meta } from "./data";

export type LocationLevel = "all" | "region" | "country" | "adm1" | "adm2";

export interface LocationFilter {
  level: LocationLevel;
  id: number;
  name: string;
}

/** A conflict, or every one when `id` is -1. */
export interface ListFilter {
  id: number;
  name: string;
}

export const ALL = -1;

export const isAll = (filter: LocationFilter | ListFilter) =>
  "level" in filter ? filter.level === "all" : filter.id === ALL;

/** The places, actors and conflicts a conflict view's events involve, so its menus offer only those. */
export interface ScopeIds {
  countries: Set<number>;
  adm1: Set<number>;
  adm2: Set<number>;
  actors: Set<number>;
  conflicts: Set<number>;
}

export function scopeIds({ attrs, meta }: EventData, scope: Uint8Array): ScopeIds {
  const ids: ScopeIds = {
    countries: new Set(),
    adm1: new Set(),
    adm2: new Set(),
    actors: new Set(),
    conflicts: new Set(),
  };
  for (let index = 0; index < meta.count; index += 1) {
    if (!scope[index]) continue;
    ids.countries.add(attrs.country[index]!);
    ids.adm1.add(attrs.adm1[index]!);
    ids.adm2.add(attrs.adm2[index]!);
    ids.actors.add(attrs.sideA[index]!);
    ids.actors.add(attrs.sideB[index]!);
    ids.conflicts.add(attrs.conflict[index]!);
  }
  return ids;
}

/**
 * Region, country, first-level and second-level divisions, as nested columns, keeping
 * to `keep`'s places when given.
 */
export function buildLocationMenu(meta: Meta, keep?: ScopeIds): MenuItem<LocationFilter>[] {
  const [regionColumn, countryColumn, adm1Column, adm2Column] = COPY.location.columns;
  const adm2ByAdm1 = new Map<number, MenuItem<LocationFilter>[]>();
  meta.adm2.forEach(({ name, adm1 }, id) => {
    if (id === 0 || (keep && !keep.adm2.has(id))) return;
    const items = adm2ByAdm1.get(adm1) ?? [];
    items.push({
      name,
      value: { level: "adm2", id, name },
      section: adm2Column,
      parent: meta.adm1[adm1]!.name,
      children: [],
    });
    adm2ByAdm1.set(adm1, items);
  });

  const adm1ByCountry = new Map<number, MenuItem<LocationFilter>[]>();
  meta.adm1.forEach(({ name, country }, id) => {
    if (id === 0 || (keep && !keep.adm1.has(id))) return;
    const items = adm1ByCountry.get(country) ?? [];
    items.push({
      name,
      value: { level: "adm1", id, name },
      section: adm1Column,
      parent: meta.countries[country]!.name,
      hint: COPY.location.noDivisions,
      children: adm2ByAdm1.get(id) ?? [],
    });
    adm1ByCountry.set(country, items);
  });

  const countriesByRegion = new Map<number, MenuItem<LocationFilter>[]>();
  meta.countries.forEach(({ name, region }, id) => {
    if (keep && !keep.countries.has(id)) return;
    const items = countriesByRegion.get(region) ?? [];
    items.push({
      name,
      value: { level: "country", id, name },
      section: countryColumn,
      parent: meta.regions[region],
      hint: COPY.location.noDivisions,
      children: adm1ByCountry.get(id) ?? [],
    });
    countriesByRegion.set(region, items);
  });

  return [
    {
      name: COPY.location.all,
      value: { level: "all", id: ALL, name: COPY.location.button },
      section: regionColumn,
      pin: "start",
      children: [],
    },
    ...meta.regions.flatMap((name, id) => {
      const children = countriesByRegion.get(id) ?? [];
      if (keep && children.length === 0) return [];
      return [{ name, value: { level: "region" as const, id, name }, section: regionColumn, children }];
    }),
  ];
}

/**
 * One column of names, with "all" pinned first, keeping to the ids in `keep` when given.
 * `button` is the control's name when nothing is picked.
 */
export function buildListMenu(
  names: string[],
  { all, button, columns }: { all: string; button: string; columns: string[] },
  keep?: Set<number>,
): MenuItem<ListFilter>[] {
  return [
    { name: all, value: { id: ALL, name: button }, section: columns[0], pin: "start", children: [] },
    ...names.flatMap((name, id) =>
      keep && !keep.has(id) ? [] : [{ name, value: { id, name }, section: columns[0], children: [] }],
    ),
  ];
}

/** The types of violence, by their UCDP codes, with "all" pinned first. */
export function buildTypeMenu(): MenuItem<ListFilter>[] {
  const { all, button, columns } = COPY.type;
  return [
    { name: all, value: { id: ALL, name: button }, section: columns[0], pin: "start", children: [] },
    ...VIOLENCE_TYPES.map((id) => {
      const name = COPY.legend.types[id];
      return { name, value: { id, name }, section: columns[0], children: [] };
    }),
  ];
}

export const toWords = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Whether each query word starts a word in the name. */
export function matchesQuery(name: string, queryWords: string[]) {
  const nameWords = toWords(name);
  return queryWords.every((query) => nameWords.some((word) => word.startsWith(query)));
}

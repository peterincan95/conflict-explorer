import type { MenuItem } from "./ColumnMenu";
import { COPY } from "./copy";
import type { Meta } from "./data";

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

/** Region, country, first-level and second-level divisions, as nested columns. */
export function buildLocationMenu(meta: Meta): MenuItem<LocationFilter>[] {
  const [regionColumn, countryColumn, adm1Column, adm2Column] = COPY.location.columns;
  const adm2ByAdm1 = new Map<number, MenuItem<LocationFilter>[]>();
  meta.adm2.forEach(({ name, adm1 }, id) => {
    if (id === 0) return;
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
    if (id === 0) return;
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
    ...meta.regions.map((name, id) => ({
      name,
      value: { level: "region" as const, id, name },
      section: regionColumn,
      children: countriesByRegion.get(id) ?? [],
    })),
  ];
}

/** One column of names, with "all" pinned first. `button` is the control's name when nothing is picked. */
export function buildListMenu(
  names: string[],
  { all, button, columns }: { all: string; button: string; columns: string[] },
): MenuItem<ListFilter>[] {
  return [
    { name: all, value: { id: ALL, name: button }, section: columns[0], pin: "start", children: [] },
    ...names.map((name, id) => ({ name, value: { id, name }, section: columns[0], children: [] })),
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

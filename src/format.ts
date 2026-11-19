import type { Toll } from "./selection";

export const numberFormat = new Intl.NumberFormat("en-US");
const shortFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Deaths in full below a thousand, then in thousands or millions to one decimal: "121.8k", "4.4M". */
export function formatDeaths(count: number) {
  if (count >= 1_000_000) return `${shortFormat.format(count / 1_000_000)}M`;
  if (count >= 1000) return `${shortFormat.format(count / 1000)}k`;
  return numberFormat.format(count);
}

/** A death toll as its best estimate, or as its range when `isRange`. */
export function formatToll({ best, low, high }: Toll, isRange: boolean, format = numberFormat.format) {
  if (!isRange) return format(best);
  return low === high ? format(low) : `${format(low)}–${format(high)}`;
}

/** "Al Fashir town, Sudan": the place, capitalized, then its country unless the place names it. */
export function placeName(place: string | undefined, country: string) {
  if (!place) return country;
  const capitalized = place[0]!.toUpperCase() + place.slice(1);
  return place.toLowerCase().includes(country.toLowerCase()) ? capitalized : `${capitalized}, ${country}`;
}

/**
 * A source citation made readable. UCDP's newer citations are quoted "outlet,date,headline"
 * entries, several to a line; those get spaces after their commas and semicolons
 * between them. Older ones are free text and stay as they are.
 */
export function formatSource(source: string) {
  const quoted = [...source.matchAll(/"([^"]*)"/g)].map(([, entry]) => entry!.trim()).filter(Boolean);
  if (quoted.length === 0) return source.trim();
  return quoted
    .map((entry) => {
      const [outlet, date, ...headline] = entry.split(",");
      return [outlet, date, headline.join(",")].filter((part) => part?.trim()).join(", ");
    })
    .join("; ");
}

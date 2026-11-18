/** Every piece of text the app shows or reads out, in one place. */
export const COPY = {
  pageTitle: "Global Conflict Fatalities",
  title: "Global Conflict Fatalities: 1989-2026",
  filterBy: "Filter By:",
  events: "events",
  fatalities: "fatalities",
  loading: "Loading conflict events",
  noWebGl: "This map needs WebGL2, which this browser doesn't support.",
  noFloatRendering: "This map needs a graphics card that supports float rendering.",
  empty: "No events match these filters. Try widening them.",
  emptyInBox: "No events match inside this box. Try a bigger box.",
  mapLabel: "Map of conflict events",

  location: {
    button: "Location",
    all: "All locations",
    columns: ["Regions", "Countries", "Provinces", "Districts"],
    search: "Search regions, countries, provinces and districts",
    noDivisions: "No smaller areas recorded",
  },
  actor: {
    button: "Actor",
    all: "All actors",
    columns: ["Actors"],
    search: "Search actors",
  },
  conflict: {
    button: "Conflict",
    all: "All conflicts",
    columns: ["Conflicts"],
    search: "Search conflicts",
  },

  menu: {
    sortByName: "A–Z",
    sortByNameTitle: "Sort alphabetically",
    sortByCount: "Most fatalities",
    sortByCountTitle: "Sort by fatalities, most first",
    results: "Results",
    resultCount: (count: number) => `${count} ${count === 1 ? "result" : "results"}`,
    noMatches: (query: string) => `No matches for “${query}”`,
    sortGroup: (column: string) => `Sort ${column.toLowerCase()}`,
    columnIn: (column: string, parent: string) => `${column} in ${parent}`,
  },

  boxSelect: "Box select",
  labels: "Labels",
  clearBox: "Clear box",
  resetView: "Reset view",
  drawHint: "Drag on the map to draw a box",

  timeline: {
    title: "Timeline",
    show: "Show timeline",
    hide: "Hide timeline",
    reset: "Reset to all dates",
    start: "Start date",
    end: "End date",
  },

  /** Read out once the filters or dates settle. */
  announcement: (events: string, fatalities: string, dates: string) =>
    `${events} events, ${fatalities} fatalities, ${dates}`,
};

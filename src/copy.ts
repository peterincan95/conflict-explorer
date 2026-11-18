/**
 * Every piece of text the app shows or reads out, in one place. Text from the mockup is
 * filled in; everything else is a placeholder to be written.
 */
export const COPY = {
  pageTitle: "Global Conflict Fatalities",
  title: "Global Conflict Fatalities: 1989-2026",
  filterBy: "Filter By:",
  events: "events",
  fatalities: "fatalities",
  loading: "Lorem ipsum dolor sit",
  noWebGl: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
  noFloatRendering: "Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do.",
  empty: "Lorem ipsum dolor sit amet. Consectetur adipiscing.",
  emptyInBox: "Lorem ipsum dolor sit amet in box. Consectetur.",
  mapLabel: "Lorem ipsum dolor",

  location: {
    button: "Location",
    all: "Lorem ipsum",
    columns: ["Lorem", "Ipsum", "Dolor", "Sit amet"],
    search: "Lorem ipsum dolor sit amet",
    noDivisions: "Lorem ipsum dolor sit",
  },
  actor: {
    button: "Actor",
    all: "Lorem ipsum",
    columns: ["Lorem ipsum"],
    search: "Lorem ipsum dolor",
  },
  conflict: {
    button: "Conflict",
    all: "Lorem ipsum",
    columns: ["Lorem ipsum"],
    search: "Lorem ipsum dolor",
  },

  menu: {
    sortByName: "A–Z",
    sortByNameTitle: "Lorem ipsum dolor",
    sortByCount: "Lorem ipsum",
    sortByCountTitle: "Lorem ipsum dolor sit amet",
    results: "Lorem",
    resultCount: (count: number) => `${count} lorem`,
    noMatches: (query: string) => `Lorem ipsum “${query}”`,
    sortGroup: (column: string) => `Lorem ${column}`,
    columnIn: (column: string, parent: string) => `${column} lorem ${parent}`,
  },

  boxSelect: "Box select",
  clearBox: "Lorem ipsum",
  resetView: "Lorem ipsum",
  drawHint: "Lorem ipsum dolor sit amet consectetur",

  timeline: {
    title: "Timeline",
    show: "Lorem ipsum",
    hide: "Lorem ipsum",
    reset: "Lorem ipsum dolor",
    start: "Lorem",
    end: "Ipsum",
  },

  /** Read out once the filters or dates settle. */
  announcement: (events: string, fatalities: string, dates: string) =>
    `Lorem ${events}, ipsum ${fatalities}, ${dates}`,
};

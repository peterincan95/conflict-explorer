/** Every piece of text the app shows or reads out, in one place. */
export const COPY = {
  pageTitle: "Global Conflict Fatalities",
  title: "Global Conflict Fatalities: 1989-2026",
  filters: {
    title: "Filter By",
    show: "Show filters",
    hide: "Hide filters",
  },
  credit: {
    text: "Data: UCDP Georeferenced Event Dataset (GED) v26.1",
    href: "https://ucdp.uu.se/",
  },
  clearFilter: (name: string) => `Clear ${name.toLowerCase()} filter`,
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
  type: {
    button: "Conflict type",
    all: "All conflict types",
    columns: ["Conflict types"],
    search: "Search conflict types",
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

  settings: {
    button: "Settings",
    fatalities: "Fatality figures",
    best: "Best estimate",
    range: "Range",
    colorByType: "Color points by conflict type",
    hillshade: "Hillshade",
    places: "Populated places",
    labels: "Labels",
  },
  legend: {
    title: "Legend",
    show: "Show legend",
    hide: "Hide legend",
    types: { 1: "State-based conflict", 2: "Non-state conflict", 3: "Violence against civilians" },
    size: "Deaths per event",
  },

  boxSelect: "Box select",
  clearBox: "Clear box",
  resetView: "Reset view",
  drawHint: "Drag on the map to draw a box",

  popup: {
    label: "Event details",
    close: "Close",
    showList: "Show all events here",
    hideList: "Back to the event",
    previous: "Previous event",
    next: "Next event",
    position: (index: number, count: number) => `${index} / ${count}`,
    listTitle: (count: string) => `${count} events here`,
    types: { 1: "state-based conflict", 2: "non-state conflict", 3: "violence against civilians" },
    /**
     * The sentence about an event. `link` turns text into a link, and the deaths come
     * as a best estimate or a range.
     */
    summary: <T>(
      type: string,
      link: (text: string, kind: "conflict" | "sideA" | "sideB") => T,
      sideA: string,
      sideB: string,
      deaths: string,
      /** "range" when the deaths are a low–high range, "exact" when every estimate agrees. */
      certainty: "range" | "estimate" | "exact",
      isOne: boolean,
    ) => [
      `This instance of ${type} was part of a `,
      link("conflict", "conflict"),
      " between ",
      link(sideA, "sideA"),
      " and ",
      link(sideB, "sideB"),
      ` and resulted in ${{ range: "an estimated ", estimate: "approximately ", exact: "" }[certainty]}${deaths} ${isOne ? "fatality" : "fatalities"}.`,
    ],
    deaths: (count: string, isOne: boolean) => `${count} ${isOne ? "death" : "deaths"}`,
    /** Labels for the deaths by side; sides A and B go by their actors' names. */
    civilians: "Civilians",
    unknown: "Unknown",
    source: "Source:",
    loadingSource: "Loading…",
    moreSource: "More",
    lessSource: "Less",
    noSource: "Not recorded",
    provisional: "Provisional: from UCDP's monthly candidate data, which may still change.",
  },

  timeline: {
    title: "Timeline",
    show: "Show timeline",
    hide: "Hide timeline",
    reset: "Reset to all dates and zoom out",
    start: "Start date",
    end: "End date",
  },

  /** Read out once the filters or dates settle. */
  announcement: (events: string, fatalities: string, dates: string) =>
    `${events} events, ${fatalities} fatalities, ${dates}`,
};

/** "the " before an actor named "Government of …", so a sentence reads "the Government of Iraq". */
const theFor = (actor: string) => (actor.startsWith("Government of") ? "the " : "");

/** Every piece of text the app shows or reads out, in one place. */
export const COPY = {
  pageTitle: "Documented Conflict Fatalities",
  title: "Documented Conflict Fatalities",
  /** The subtitle under the title: the months the timeline covers, "Jan 1989–Oct 2026". */
  dateRange: (from: string, to: string) => `${from}–${to}`,
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
  /** An actor named by an acronym, spelled out: "Islamic State (IS)". */
  actorFullName: (full: string, acronym: string) => `${full} (${acronym})`,
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

  /** The map picker at the bottom right. Placeholders to fill in, apart from "Global". */
  views: {
    global: "Global",
    /** The tile's label for screen readers and its tooltip, given the map showing. */
    change: (current: string) => `Lorem ipsum dolor: ${current}`,
    /** The open list of other maps, for screen readers. */
    choices: "Lorem ipsum dolor",
  },

  /** The panel open at launch: what the data is, then how to use the map. */
  info: {
    /** The pill that reopens the panel, for screen readers and its tooltip. */
    button: "About this map",
    title: "About this map",
    close: "Close",
    /** One or two sentences on the UCDP dataset. */
    about:
      "The Uppsala Conflict Data Program's Georeferenced Event Dataset records every documented instance of organized violence that killed at least one person since 1989. Each event is placed where and when it happened, with an estimate of how many people were killed.",
    /** How to use the map, one bullet each. */
    steps: [
      "Scroll or pinch to zoom, and drag to pan. Each point is an event, sized by its death toll.",
      "Zoom in and click a point to see what happened, who was involved and the source.",
      "Drag the timeline's handles to choose dates, or drag the range between them to move through time.",
      "Use Filter By to narrow events by location, actor, conflict or type of violence.",
      "Use Box select to draw a box on the map and total the events inside it.",
      "Use the Views menu at the bottom right to follow one war month by month, with its key events marked.",
    ],
    /** The button that closes the panel and starts exploring. */
    start: "Start exploring",
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
      ` between ${theFor(sideA)}`,
      link(sideA, "sideA"),
      ` and ${theFor(sideB)}`,
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

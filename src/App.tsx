import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoxOutline, useBoxDraw, type Box } from "./box";
import { ColumnMenu } from "./ColumnMenu";
import { COPY } from "./copy";
import {
  formatDays,
  loadDetails,
  loadEvents,
  loadLabels,
  loadOutlines,
  monthName,
  VIOLENCE_TYPES,
  type Details,
  type EventData,
  type ViolenceType,
} from "./data";
import {
  buildListMenu,
  buildLocationMenu,
  isAll,
  type ListFilter,
  type LocationFilter,
} from "./filters";
import { Legend } from "./Legend";
import { MapView } from "./mapView";
import { DEFAULT_GRADIENT, EventRenderer, TYPE_COLORS } from "./renderer";
import { Settings, type FatalityMode } from "./Settings";
import {
  countConflicts,
  countLocations,
  fatalitiesByMonth,
  filterEvents,
  filteredBounds,
  filteredDays,
  monthOfDay,
  topEvents,
  totals,
  WHOLE_WORLD,
  type Area,
  type DayWindow,
  type Filters,
  type MenuCounts,
  type Toll,
} from "./selection";
import { MIN_VIEW_DAYS, Timeline, type ChartSeries, type DayView, type MonthRange } from "./Timeline";
import { TopEvents, type TopEvent } from "./TopEvents";

const ANNOUNCE_DELAY_MS = 600;
// The deadliest events list starts this long and grows this much at a time.
const TOP_EVENTS_STEP = 25;
// Zooming the timeline to a filter leaves this share of its days either side.
const VIEW_PADDING = 0.05;
const numberFormat = new Intl.NumberFormat("en-US");

/** "Al Fashir town, Sudan": the place, capitalized, then its country unless the place names it. */
function placeName(place: string | undefined, country: string) {
  if (!place) return country;
  const capitalized = place[0]!.toUpperCase() + place.slice(1);
  return place.toLowerCase().includes(country.toLowerCase()) ? capitalized : `${capitalized}, ${country}`;
}

const shortFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Deaths in full below a thousand, then in thousands or millions to one decimal: "121.8k", "4.4M". */
export function formatDeaths(count: number) {
  if (count >= 1_000_000) return `${shortFormat.format(count / 1_000_000)}M`;
  if (count >= 1000) return `${shortFormat.format(count / 1000)}k`;
  return numberFormat.format(count);
}

/** A death toll as its best estimate, or as its range when `isRange`. */
function formatToll({ best, low, high }: Toll, isRange: boolean, format = numberFormat.format) {
  if (!isRange) return format(best);
  return low === high ? format(low) : `${format(low)}–${format(high)}`;
}

export function App() {
  const [data, setData] = useState<EventData | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = COPY.pageTitle;
    loadEvents(setProgress).then(setData, (reason: Error) => setError(reason.message));
  }, []);

  if (error) return <p className="status">{error}</p>;
  if (!data) {
    return (
      <p className="status" role="status">
        {COPY.loading}… {Math.round(progress * 100)}%
      </p>
    );
  }
  return <Explorer data={data} />;
}

/**
 * Puts off an expensive count until a menu asks for it, then keeps the answer. Menus
 * show deaths, and hide items with no events.
 */
function lazyCounts<T>(count: () => MenuCounts<T>) {
  let counts: MenuCounts<T> | null = null;
  return {
    fatalities: (value: T) => (counts ??= count()).fatalities(value),
    range: (value: T) => {
      counts ??= count();
      return [counts.low(value), counts.high(value)] as const;
    },
    hasEntries: (value: T) => (counts ??= count()).events(value) > 0,
  };
}

function Explorer({ data }: { data: EventData }) {
  const { meta } = data;
  const lastMonth = meta.months.length - 1;
  const fullRange: MonthRange = [0, lastMonth];
  const fullView: DayView = [meta.months[0]!.day, meta.months[lastMonth]!.day];

  const locationMenu = useMemo(() => buildLocationMenu(meta), [meta]);
  const conflictMenu = useMemo(() => buildListMenu(meta.conflicts, COPY.conflict), [meta]);
  const monthOf = useMemo(() => monthOfDay(meta), [meta]);

  const [location, setLocation] = useState<LocationFilter>(locationMenu[0]!.value!);
  const [conflict, setConflict] = useState<ListFilter>(conflictMenu[0]!.value!);
  const [range, setRange] = useState<MonthRange>(fullRange);
  const [timelineView, setTimelineView] = useState<DayView>(fullView);
  const [topLimit, setTopLimit] = useState(TOP_EVENTS_STEP);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [isSideOpen, setIsSideOpen] = useState(false);
  const [area, setArea] = useState<Area>(WHOLE_WORLD);
  const [isDrawingBox, setIsDrawingBox] = useState(false);
  const [isMapMoved, setIsMapMoved] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [isTimelineOpen, setIsTimelineOpen] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [fatalityMode, setFatalityMode] = useState<FatalityMode>("best");
  const [colorByType, setColorByType] = useState(false);

  const canvas = useRef<HTMLCanvasElement>(null);
  const linesCanvas = useRef<HTMLCanvasElement>(null);
  const mapPlot = useRef<HTMLDivElement>(null);
  const startHandle = useRef<HTMLDivElement>(null);
  const renderer = useRef<EventRenderer | null>(null);
  const mapView = useRef<MapView | null>(null);

  const isFiltered = range[0] > 0 || range[1] < lastMonth;
  const hasBox = area !== WHOLE_WORLD;
  const dayWindow: DayWindow = useMemo(
    () => ({ from: meta.months[range[0]]!.day, to: meta.months[range[1]]!.day }),
    [meta, range],
  );
  const filters: Filters = useMemo(
    () => ({ location, conflict }),
    [location, conflict],
  );

  // Ranges show once the low and high estimates have loaded.
  const isRange = fatalityMode === "range" && details !== null;

  const filtered = useMemo(() => filterEvents(data, filters), [data, filters]);
  const monthlyFatalities = useMemo(
    () => fatalitiesByMonth(data, filtered.visible, area, monthOf),
    [data, filtered, area, monthOf],
  );
  // One series for all events, or one per type of violence when points show types. The
  // chart always uses the best estimate, even when the rest shows ranges.
  const chartSeries: ChartSeries[] = useMemo(() => {
    if (!colorByType) return [{ key: "all", color: DEFAULT_GRADIENT.at(-2)!, values: monthlyFatalities }];
    return VIOLENCE_TYPES.map((type) => ({
      key: String(type),
      color: TYPE_COLORS[type],
      values: fatalitiesByMonth(data, filtered.visible, area, monthOf, data.best, type),
    }));
  }, [colorByType, data, filtered, area, monthOf, monthlyFatalities]);
  const total = useMemo(
    () => totals(data, details, filtered.visible, area, dayWindow),
    [data, details, filtered, area, dayWindow],
  );

  // One extra tells the list whether there are more to show.
  const top = useMemo(
    () => topEvents(data, filtered.visible, area, dayWindow, topLimit + 1),
    [data, filtered, area, dayWindow, topLimit],
  );
  const topRows: TopEvent[] = top.slice(0, topLimit).map((index) => {
    const country = meta.countries[data.attrs.country[index]!]!.name;
    const place = details?.places[details.place[index]!];
    const best = data.best[index]!;
    const toll = { best, low: details?.low[index] ?? best, high: details?.high[index] ?? best };
    const isOne = isRange ? toll.high === 1 : best === 1;
    return {
      index,
      place: placeName(place, country),
      date: formatDays(meta.epoch, data.start[index]!, data.end[index]!),
      fatalities: COPY.topEvents.deaths(formatToll(toll, isRange, formatDeaths), isOne),
      color: colorByType ? TYPE_COLORS[data.attrs.type[index] as ViolenceType] : null,
    };
  });

  const locationCounts = useMemo(
    () => lazyCounts(() => countLocations(data, details, filters, area, dayWindow)),
    [data, details, filters, area, dayWindow],
  );
  const conflictCounts = useMemo(
    () => lazyCounts(() => countConflicts(data, details, filters, area, dayWindow)),
    [data, details, filters, area, dayWindow],
  );

  const formatMonth = (index: number) => {
    const { month, year } = meta.months[index]!;
    return `${monthName(month)} ${year}`;
  };
  const eventCount = numberFormat.format(total.events);
  const fatalityCount = formatToll(total.fatalities, isRange, formatDeaths);
  const dates = `${formatMonth(range[0])} – ${formatMonth(range[1] - 1)}`;
  const description = COPY.announcement(eventCount, fatalityCount, dates);

  useLayoutEffect(() => {
    let current: EventRenderer;
    try {
      current = new EventRenderer(canvas.current!, data, COPY);
    } catch (reason) {
      setError((reason as Error).message);
      return;
    }
    renderer.current = current;
    const view = new MapView(mapPlot.current!, linesCanvas.current!, current, meta.extent, setIsMapMoved);
    mapView.current = view;
    if (import.meta.env.DEV) Object.assign(globalThis, { eventRenderer: current, mapView: view });

    // Outlines come after the points, and the map works without them.
    let isCurrent = true;
    loadOutlines()
      .then((outlines) => {
        if (isCurrent) current.setOutlines(outlines);
      })
      .catch((reason: unknown) => console.warn("Country outlines didn't load", reason));
    loadLabels()
      .then((labels) => {
        if (isCurrent) view.setLabels(labels);
      })
      .catch((reason: unknown) => console.warn("Country labels didn't load", reason));
    loadDetails(meta.count)
      .then((loaded) => {
        if (isCurrent) setDetails(loaded);
      })
      .catch((reason: unknown) => console.warn("Death ranges and place names didn't load", reason));

    const updateLayout = () => {
      const { width, height } = mapPlot.current!.getBoundingClientRect();
      current.setLayout(width, height);
      view.setLayout(width, height);
    };
    const observer = new ResizeObserver(updateLayout);
    observer.observe(mapPlot.current!);
    updateLayout();

    return () => {
      isCurrent = false;
      observer.disconnect();
      view.destroy();
      current.destroy();
      mapView.current = null;
      renderer.current = null;
    };
  }, [data, meta]);

  useLayoutEffect(() => {
    renderer.current?.setVisible(filtered.visible);
  }, [filtered]);

  useLayoutEffect(() => {
    renderer.current?.setWindow(dayWindow, total.shown);
  }, [dayWindow, total.shown]);

  useLayoutEffect(() => {
    renderer.current?.setColorByType(colorByType);
  }, [colorByType]);

  useLayoutEffect(() => {
    renderer.current?.setArea(area);
    mapView.current?.setArea(area);
  }, [area]);

  useEffect(() => {
    mapView.current?.setLabelsVisible(showLabels);
  }, [showLabels]);

  useEffect(() => {
    const index = highlighted;
    mapView.current?.setHighlight(
      index === null ? null : { x: data.x[index]!, y: data.y[index]!, deaths: data.best[index]! },
    );
  }, [data, highlighted]);

  // A new filter zooms the map and the timeline to its events, and clearing every filter
  // zooms back out. The first render is the default view already.
  const hasZoomed = useRef(false);
  useEffect(() => {
    setTopLimit(TOP_EVENTS_STEP);
    setHighlighted(null);
    if (!hasZoomed.current) {
      hasZoomed.current = true;
      return;
    }
    const isUnfiltered = isAll(filters.location) && isAll(filters.conflict);
    const bounds = isUnfiltered ? null : filteredBounds(data, filtered.visible, filtered.count);
    mapView.current?.fitTo(bounds);
    const days = isUnfiltered ? null : filteredDays(data, filtered.visible);
    if (!days) {
      setTimelineView(fullView);
      return;
    }
    const [first, final] = fullView;
    const padding = (days.to - days.from) * VIEW_PADDING;
    const span = Math.min(Math.max(days.to - days.from + 2 * padding, MIN_VIEW_DAYS), final - first);
    const middle = (days.from + days.to) / 2;
    const start = Math.min(Math.max(middle - span / 2, first), final - span);
    setTimelineView([start, start + span]);
    // fullView is rebuilt each render but only changes with the data, so it isn't a dependency.
  }, [data, filtered]);

  useEffect(() => {
    mapView.current?.setPanEnabled(!isDrawingBox);
    if (!isDrawingBox) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsDrawingBox(false);
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [isDrawingBox]);

  // Screen readers hear the result once things settle, not every month of a drag.
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(description), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [description]);

  const drawOnMap = (box: Box) => {
    setArea(mapView.current!.boxToArea(box));
    setIsDrawingBox(false);
  };
  const mapDraw = useBoxDraw(drawOnMap);

  const resetRange = () => {
    setRange(fullRange);
    setTimelineView(fullView);
    startHandle.current?.focus();
  };

  if (error) return <p className="status">{error}</p>;

  let emptyMessage = null;
  if (total.events === 0) emptyMessage = hasBox ? COPY.emptyInBox : COPY.empty;

  return (
    <main className="app">
      <header className="header">
        <h1>{COPY.title}</h1>
        <div className="filters">
          <span className="filters-label">{COPY.filterBy}</span>
          <ColumnMenu
            id="location"
            label={COPY.location.button}
            items={locationMenu}
            columnNames={COPY.location.columns}
            unsortedColumns={[0]}
            searchLabel={COPY.location.search}
            selected={location}
            selectedName={location.name}
            onSelect={setLocation}
            countOf={locationCounts.fatalities}
            rangeOf={isRange ? locationCounts.range : undefined}
            hasEntries={locationCounts.hasEntries}
            isActive={!isAll(location)}
          />
          <ColumnMenu
            id="conflict"
            label={COPY.conflict.button}
            items={conflictMenu}
            columnNames={COPY.conflict.columns}
            searchLabel={COPY.conflict.search}
            selected={conflict}
            selectedName={conflict.name}
            onSelect={setConflict}
            countOf={conflictCounts.fatalities}
            rangeOf={isRange ? conflictCounts.range : undefined}
            hasEntries={conflictCounts.hasEntries}
            isActive={!isAll(conflict)}
          />
        </div>
        <div className="summary">
          <p>
            <strong>{eventCount}</strong> {COPY.events}
          </p>
          <p>
            <strong>{fatalityCount}</strong> {COPY.fatalities}
          </p>
        </div>
      </header>

      <p className="visually-hidden" role="status">
        {announcement}
      </p>

      <section className="stage" aria-label={COPY.mapLabel}>
        <canvas className="points" ref={canvas} aria-hidden="true" />
        <canvas className="map-lines" ref={linesCanvas} aria-hidden="true" />
        <div
          className={isDrawingBox ? "plot drawing-box" : "plot"}
          ref={mapPlot}
          role="img"
          aria-label={`${COPY.mapLabel}. ${description}`}
          {...(isDrawingBox ? mapDraw.handlers : {})}
        >
          {mapDraw.draft && <BoxOutline box={mapDraw.draft} draft />}
        </div>
        {emptyMessage && <p className="empty">{emptyMessage}</p>}
        <Legend mapView={mapView} colorByType={colorByType} />
        <div className="box-bar">
          <Settings
            fatalityMode={fatalityMode}
            onFatalityModeChange={setFatalityMode}
            colorByType={colorByType}
            onColorByTypeChange={setColorByType}
          />
          <button
            className="pill"
            type="button"
            aria-pressed={isDrawingBox}
            onClick={() => setIsDrawingBox(!isDrawingBox)}
          >
            {COPY.boxSelect}
          </button>
          <button
            className="pill"
            type="button"
            aria-pressed={showLabels}
            onClick={() => setShowLabels(!showLabels)}
          >
            {COPY.labels}
          </button>
          {hasBox && (
            <button className="pill" type="button" onClick={() => setArea(WHOLE_WORLD)}>
              {COPY.clearBox}
            </button>
          )}
          {isMapMoved && (
            <button className="pill" type="button" onClick={() => mapView.current?.resetView()}>
              {COPY.resetView}
            </button>
          )}
          {isDrawingBox && <p>{COPY.drawHint}</p>}
        </div>
      </section>

      <Timeline
        months={meta.months}
        series={chartSeries}
        chartStyle={colorByType ? "lines" : "area"}
        range={range}
        isFiltered={isFiltered}
        view={timelineView}
        onViewChange={setTimelineView}
        formatMonth={formatMonth}
        onChange={setRange}
        onReset={resetRange}
        startHandle={startHandle}
        isOpen={isTimelineOpen}
        onToggle={setIsTimelineOpen}
      />

      <TopEvents
        isOpen={isSideOpen}
        onToggle={setIsSideOpen}
        events={topRows}
        hasMore={top.length > topLimit}
        onShowMore={() => setTopLimit(topLimit + TOP_EVENTS_STEP)}
        onHighlight={setHighlighted}
        onSelect={(index) => mapView.current?.focusOn(data.x[index]!, data.y[index]!)}
      />
    </main>
  );
}

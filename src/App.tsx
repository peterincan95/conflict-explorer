import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoxOutline, useBoxDraw, type Box } from "./box";
import { ColumnMenu } from "./ColumnMenu";
import { COPY } from "./copy";
import { loadEvents, loadLabels, loadOutlines, monthName, type EventData } from "./data";
import {
  buildListMenu,
  buildLocationMenu,
  isAll,
  type ListFilter,
  type LocationFilter,
} from "./filters";
import { MapView } from "./mapView";
import { DEFAULT_GRADIENT, EventRenderer } from "./renderer";
import {
  countActors,
  countConflicts,
  countLocations,
  fatalitiesByMonth,
  filterEvents,
  monthOfDay,
  totals,
  WHOLE_WORLD,
  type Area,
  type DayWindow,
  type Filters,
  type MenuCounts,
} from "./selection";
import { Timeline, type MonthRange } from "./Timeline";

const ANNOUNCE_DELAY_MS = 600;
const numberFormat = new Intl.NumberFormat("en-US");

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
    hasEntries: (value: T) => (counts ??= count()).events(value) > 0,
  };
}

function Explorer({ data }: { data: EventData }) {
  const { meta } = data;
  const lastMonth = meta.months.length - 1;
  const fullRange: MonthRange = [0, lastMonth];

  const locationMenu = useMemo(() => buildLocationMenu(meta), [meta]);
  const actorMenu = useMemo(() => buildListMenu(meta.actors, COPY.actor), [meta]);
  const conflictMenu = useMemo(() => buildListMenu(meta.conflicts, COPY.conflict), [meta]);
  const monthOf = useMemo(() => monthOfDay(meta), [meta]);

  const [location, setLocation] = useState<LocationFilter>(locationMenu[0]!.value!);
  const [actor, setActor] = useState<ListFilter>(actorMenu[0]!.value!);
  const [conflict, setConflict] = useState<ListFilter>(conflictMenu[0]!.value!);
  const [range, setRange] = useState<MonthRange>(fullRange);
  const [area, setArea] = useState<Area>(WHOLE_WORLD);
  const [isDrawingBox, setIsDrawingBox] = useState(false);
  const [isMapMoved, setIsMapMoved] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [isTimelineOpen, setIsTimelineOpen] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    () => ({ location, actor, conflict }),
    [location, actor, conflict],
  );

  const filtered = useMemo(() => filterEvents(data, filters), [data, filters]);
  const monthlyFatalities = useMemo(
    () => fatalitiesByMonth(data, filtered.visible, area, monthOf),
    [data, filtered, area, monthOf],
  );
  const total = useMemo(
    () => totals(data, filtered.visible, area, dayWindow),
    [data, filtered, area, dayWindow],
  );

  const locationCounts = useMemo(
    () => lazyCounts(() => countLocations(data, filters, area, dayWindow)),
    [data, filters, area, dayWindow],
  );
  const actorCounts = useMemo(
    () => lazyCounts(() => countActors(data, filters, area, dayWindow)),
    [data, filters, area, dayWindow],
  );
  const conflictCounts = useMemo(
    () => lazyCounts(() => countConflicts(data, filters, area, dayWindow)),
    [data, filters, area, dayWindow],
  );

  const formatMonth = (index: number) => {
    const { month, year } = meta.months[index]!;
    return `${monthName(month)} ${year}`;
  };
  const eventCount = numberFormat.format(total.events);
  const fatalityCount = numberFormat.format(total.fatalities);
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
    renderer.current?.setArea(area);
    mapView.current?.setArea(area);
  }, [area]);

  useEffect(() => {
    mapView.current?.setLabelsVisible(showLabels);
  }, [showLabels]);

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
            hasEntries={locationCounts.hasEntries}
            isActive={!isAll(location)}
          />
          <ColumnMenu
            id="actor"
            label={COPY.actor.button}
            items={actorMenu}
            columnNames={COPY.actor.columns}
            searchLabel={COPY.actor.search}
            selected={actor}
            selectedName={actor.name}
            onSelect={setActor}
            countOf={actorCounts.fatalities}
            hasEntries={actorCounts.hasEntries}
            isActive={!isAll(actor)}
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
        <div className="box-bar">
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
        monthlyValues={monthlyFatalities}
        range={range}
        isFiltered={isFiltered}
        formatMonth={formatMonth}
        onChange={setRange}
        onReset={resetRange}
        startHandle={startHandle}
        isOpen={isTimelineOpen}
        onToggle={setIsTimelineOpen}
        chartColor={DEFAULT_GRADIENT.at(-2)!}
      />
    </main>
  );
}

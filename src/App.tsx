import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoxOutline, useBoxDraw, type Box } from "./box";
import { ColumnMenu } from "./ColumnMenu";
import { COPY } from "./copy";
import { EventPopup } from "./EventPopup";
import {
  loadDetails,
  loadEvents,
  loadBasemap,
  loadHillshade,
  loadLines,
  monthName,
  VIOLENCE_TYPES,
  type Details,
  type EventData,
} from "./data";
import {
  buildListMenu,
  buildLocationMenu,
  buildTypeMenu,
  isAll,
  type ListFilter,
  type LocationFilter,
} from "./filters";
import { Legend } from "./Legend";
import { actorLabels, formatDeaths, formatToll, numberFormat } from "./format";
import { MapView } from "./mapView";
import { EventPicker } from "./picking";
import { DEFAULT_GRADIENT, DETAIL_LINE_ZOOM, EventRenderer, TYPE_COLORS } from "./renderer";
import { Settings, type FatalityMode, type MapToggles } from "./Settings";
import {
  countActors,
  countConflicts,
  countTypes,
  countLocations,
  fatalitiesByMonth,
  filterEvents,
  filteredBounds,
  filteredDays,
  monthOfDay,
  totals,
  WHOLE_WORLD,
  type Area,
  type DayWindow,
  type Filters,
  type MenuCounts,
} from "./selection";
import { MIN_VIEW_DAYS, Timeline, type ChartSeries, type DayView, type MonthRange } from "./Timeline";

const ANNOUNCE_DELAY_MS = 600;
// Zooming the timeline to a filter leaves this share of its days either side.
const VIEW_PADDING = 0.05;
// The space between the floating panels and the open part of the map, in CSS pixels,
// which is also the space between them and the pills and legend at its edges.
const PANEL_GAP = 16;
const PHONE_QUERY = "(max-width: 760px)";

/** Events open in the popup: the ones under a click, and the clicked spot. */
interface Popup {
  events: number[];
  spot: { x: number; y: number };
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
  const actorNames = useMemo(() => actorLabels(meta), [meta]);
  const actorMenu = useMemo(() => buildListMenu(actorNames, COPY.actor), [actorNames]);
  const conflictMenu = useMemo(() => buildListMenu(meta.conflicts, COPY.conflict), [meta]);
  const typeMenu = useMemo(() => buildTypeMenu(), []);
  const picker = useMemo(() => new EventPicker(data), [data]);
  const monthOf = useMemo(() => monthOfDay(meta), [meta]);

  const [location, setLocation] = useState<LocationFilter>(locationMenu[0]!.value!);
  const [actor, setActor] = useState<ListFilter>(actorMenu[0]!.value!);
  const [type, setType] = useState<ListFilter>(typeMenu[0]!.value!);
  const [conflict, setConflict] = useState<ListFilter>(conflictMenu[0]!.value!);
  const [range, setRange] = useState<MonthRange>(fullRange);
  const [timelineView, setTimelineView] = useState<DayView>(fullView);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [shownEvent, setShownEvent] = useState<number | null>(null);
  const [area, setArea] = useState<Area>(WHOLE_WORLD);
  const [isDrawingBox, setIsDrawingBox] = useState(false);
  const [isMapMoved, setIsMapMoved] = useState(false);
  const [isTimelineOpen, setIsTimelineOpen] = useState(true);
  // Filters start open, except on phones, where they'd cover much of the map.
  const [isFiltersOpen, setIsFiltersOpen] = useState(() => !window.matchMedia(PHONE_QUERY).matches);
  const [isLegendOpen, setIsLegendOpen] = useState(() => !window.matchMedia(PHONE_QUERY).matches);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [fatalityMode, setFatalityMode] = useState<FatalityMode>("best");
  const [toggles, setToggles] = useState<MapToggles>({
    colorByType: false,
    hillshade: true,
    places: true,
    labels: true,
  });
  const { colorByType } = toggles;

  const canvas = useRef<HTMLCanvasElement>(null);
  const linesCanvas = useRef<HTMLCanvasElement>(null);
  const mapPlot = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const timelineDock = useRef<HTMLDivElement>(null);
  const boxBar = useRef<HTMLDivElement>(null);
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
    () => ({ location, actor, conflict, type }),
    [location, actor, conflict, type],
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

  const locationCounts = useMemo(
    () => lazyCounts(() => countLocations(data, details, filters, area, dayWindow)),
    [data, details, filters, area, dayWindow],
  );
  const actorCounts = useMemo(
    () => lazyCounts(() => countActors(data, details, filters, area, dayWindow)),
    [data, details, filters, area, dayWindow],
  );
  const conflictCounts = useMemo(
    () => lazyCounts(() => countConflicts(data, details, filters, area, dayWindow)),
    [data, details, filters, area, dayWindow],
  );
  const typeCounts = useMemo(
    () => lazyCounts(() => countTypes(data, details, filters, area, dayWindow)),
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
    view.setPicking(picker, {
      onPick: (events, spot) => setPopup({ events, spot }),
      onMiss: () => setPopup(null),
    });
    if (import.meta.env.DEV) Object.assign(globalThis, { eventRenderer: current, mapView: view });

    // The basemap comes after the points, and the map works without it. The detailed
    // lines wait until the map zooms close enough to need them.
    let isCurrent = true;
    let stopWatchingZoom = () => {};
    loadBasemap()
      .then((basemap) => {
        if (!isCurrent) return;
        view.setBasemap(basemap);
        loadLines("coarse", basemap)
          .then(({ segments, counts }) => {
            if (isCurrent) current.setLines("coarse", segments, counts);
          })
          .catch((reason: unknown) => console.warn("Map lines didn't load", reason));
        const loadFine = () => {
          stopWatchingZoom();
          loadLines("fine", basemap)
            .then(({ segments, counts }) => {
              if (isCurrent) current.setLines("fine", segments, counts);
            })
            .catch((reason: unknown) => console.warn("Detailed map lines didn't load", reason));
        };
        // Starts a little early, so the lines are there by the time they're used.
        const needsFine = (zoom: number) => zoom >= DETAIL_LINE_ZOOM / 2;
        if (needsFine(view.zoom)) loadFine();
        else stopWatchingZoom = view.onZoom((zoom) => needsFine(zoom) && loadFine());
        return loadHillshade().then((image) => {
          if (isCurrent) current.setHillshade(image, basemap.hillshade.flat);
        });
      })
      .catch((reason: unknown) => console.warn("The basemap didn't load", reason));
    loadDetails(meta.count)
      .then((loaded) => {
        if (isCurrent) setDetails(loaded);
      })
      .catch((reason: unknown) => console.warn("Death ranges and place names didn't load", reason));

    // The map fills the window, and the world fits the open part between the header
    // and timeline floating over it.
    const updateLayout = () => {
      const plot = mapPlot.current!.getBoundingClientRect();
      const headerBox = header.current!.getBoundingClientRect();
      // The map starts below the header. Beside it, or floating on the left on narrow
      // screens, the filters panel doesn't push the map down.
      const top = headerBox.bottom - plot.top + PANEL_GAP;
      const bottom = timelineDock.current!.getBoundingClientRect().top - plot.top - PANEL_GAP;
      current.setLayout(plot.width, plot.height);
      view.setLayout(plot.width, plot.height);
      view.setFrame({ left: 0, top, width: plot.width, height: Math.max(bottom - top, 1) });
      const stage = mapPlot.current!.parentElement!;
      stage.style.setProperty("--open-top", `${top}px`);
      stage.style.setProperty("--open-bottom", `${plot.height - bottom}px`);
      stage.parentElement!.style.setProperty("--header-bottom", `${headerBox.bottom - plot.top}px`);
      // On narrow screens the filters sit just under the pills, which can wrap.
      const pillsBottom = boxBar.current!.getBoundingClientRect().bottom - plot.top;
      stage.parentElement!.style.setProperty("--pills-bottom", `${pillsBottom}px`);
    };
    const observer = new ResizeObserver(updateLayout);
    observer.observe(mapPlot.current!);
    observer.observe(header.current!);
    observer.observe(boxBar.current!);
    observer.observe(timelineDock.current!);
    updateLayout();

    return () => {
      isCurrent = false;
      stopWatchingZoom();
      observer.disconnect();
      view.destroy();
      current.destroy();
      mapView.current = null;
      renderer.current = null;
      setPopup(null);
    };
  }, [data, meta, picker]);

  useLayoutEffect(() => {
    renderer.current?.setVisible(filtered.visible);
    picker.setVisible(filtered.visible);
  }, [filtered, picker]);

  useLayoutEffect(() => {
    renderer.current?.setWindow(dayWindow, total.shown);
    picker.setWindow(dayWindow);
  }, [dayWindow, total.shown, picker]);

  useLayoutEffect(() => {
    renderer.current?.setColorByType(colorByType);
  }, [colorByType]);

  useLayoutEffect(() => {
    renderer.current?.setArea(area);
    mapView.current?.setArea(area);
  }, [area]);

  useEffect(() => {
    mapView.current?.setLabelsVisible(toggles.labels);
    mapView.current?.setPlacesVisible(toggles.places);
    renderer.current?.setReliefVisible(toggles.hillshade);
  }, [toggles]);

  // The event the popup shows keeps a ring on the map.
  const index = popup ? shownEvent : null;
  useEffect(() => {
    mapView.current?.setHighlight(
      index === null ? null : { x: data.x[index]!, y: data.y[index]!, deaths: data.best[index]! },
    );
  }, [data, index]);
  const closePopup = useCallback(() => setPopup(null), []);

  // A new filter zooms the map and the timeline to its events, and clearing every filter
  // zooms back out. The first render is the default view already.
  // A new conflict or actor filter also sets the date range to the months its events
  // span, so the subtitle and timeline show its timespan; clearing both resets it.
  const hasZoomed = useRef(false);
  const lastPicked = useRef({ conflict: filters.conflict.id, actor: filters.actor.id });
  useEffect(() => {
    if (!hasZoomed.current) {
      hasZoomed.current = true;
      return;
    }
    const isUnfiltered = Object.values(filters).every(isAll);
    const bounds = isUnfiltered ? null : filteredBounds(data, filtered.visible, filtered.count);
    mapView.current?.fitTo(bounds);
    const days = isUnfiltered ? null : filteredDays(data, filtered.visible);

    const { conflict, actor } = filters;
    const isNewPick = conflict.id !== lastPicked.current.conflict || actor.id !== lastPicked.current.actor;
    lastPicked.current = { conflict: conflict.id, actor: actor.id };
    if (isNewPick) {
      if (isAll(conflict) && isAll(actor)) setRange(fullRange);
      else if (days) setRange([monthOf[days.from]!, monthOf[days.to - 1]! + 1]);
    }

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
    // fullView, fullRange and filters are rebuilt each render, but filtered follows filters
    // and the others only change with the data, so they aren't dependencies.
  }, [data, filtered, monthOf]);

  useEffect(() => {
    mapView.current?.setPanEnabled(!isDrawingBox);
    if (!isDrawingBox) return;
    setPopup(null);
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
      <header className="header glass" ref={header}>
        <div className="title-block">
          <h1>{COPY.title}</h1>
          {/* Follows the timeline's range as it's dragged. */}
          <p className="subtitle">{COPY.dateRange(formatMonth(range[0]), formatMonth(range[1] - 1))}</p>
          <p className="summary">
            <strong>{eventCount}</strong> {COPY.events}
            <span className="summary-divider" aria-hidden="true">
              |
            </span>
            <strong>{fatalityCount}</strong> {COPY.fatalities}
          </p>
        </div>
        <p className="credit">
          <a href={COPY.credit.href} target="_blank" rel="noreferrer">
            {COPY.credit.text}
          </a>
        </p>
      </header>

      <section
        className={isFiltersOpen ? "filters-panel glass" : "filters-panel glass collapsed"}
        aria-label={COPY.filters.title}
      >
        <button
          type="button"
          className="filters-toggle"
          aria-expanded={isFiltersOpen}
          aria-controls="filters-body"
          title={isFiltersOpen ? COPY.filters.hide : COPY.filters.show}
          onClick={() => setIsFiltersOpen(!isFiltersOpen)}
        >
          <span className="filters-title">{COPY.filters.title}</span>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d={isFiltersOpen ? "M3.5 10 8 5.5 12.5 10" : "M3.5 6 8 10.5 12.5 6"} />
          </svg>
        </button>
        {isFiltersOpen && (
          <div className="filters" id="filters-body">
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
              onClear={() => setLocation(locationMenu[0]!.value!)}
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
              rangeOf={isRange ? actorCounts.range : undefined}
              hasEntries={actorCounts.hasEntries}
              isActive={!isAll(actor)}
              onClear={() => setActor(actorMenu[0]!.value!)}
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
              onClear={() => setConflict(conflictMenu[0]!.value!)}
            />
            <ColumnMenu
              id="type"
              label={COPY.type.button}
              items={typeMenu}
              columnNames={COPY.type.columns}
              searchLabel={COPY.type.search}
              selected={type}
              selectedName={type.name}
              onSelect={setType}
              countOf={typeCounts.fatalities}
              rangeOf={isRange ? typeCounts.range : undefined}
              hasEntries={typeCounts.hasEntries}
              isActive={!isAll(type)}
              onClear={() => setType(typeMenu[0]!.value!)}
            />
          </div>
        )}
      </section>

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
        {popup && mapView.current && (
          <EventPopup
            key={popup.events.join(",")}
            data={data}
            details={details}
            events={popup.events}
            spot={popup.spot}
            mapView={mapView.current}
            isRange={isRange}
            colorByType={colorByType}
            onShow={setShownEvent}
            actorNames={actorNames}
            activeConflict={isAll(conflict) ? null : conflict.id}
            activeActor={isAll(actor) ? null : actor.id}
            // A popup filters by one of its conflict and actors at a time, so turning one
            // on turns the other kind off.
            onToggleConflict={(id) => {
              if (conflict.id === id) {
                setConflict(conflictMenu[0]!.value!);
                return;
              }
              setConflict({ id, name: meta.conflicts[id]! });
              setActor(actorMenu[0]!.value!);
            }}
            onToggleActor={(id) => {
              if (actor.id === id) {
                setActor(actorMenu[0]!.value!);
                return;
              }
              setActor({ id, name: actorNames[id]! });
              setConflict(conflictMenu[0]!.value!);
            }}
            onClose={closePopup}
          />
        )}
        <Legend
          mapView={mapView}
          colorByType={colorByType}
          isOpen={isLegendOpen}
          onToggle={setIsLegendOpen}
        />
        <div className="box-bar" ref={boxBar}>
          <Settings
            fatalityMode={fatalityMode}
            onFatalityModeChange={setFatalityMode}
            toggles={toggles}
            onTogglesChange={setToggles}
          />
          <button
            className="pill"
            type="button"
            aria-pressed={isDrawingBox}
            onClick={() => setIsDrawingBox(!isDrawingBox)}
          >
            {COPY.boxSelect}
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

      <div className="timeline-dock" ref={timelineDock}>
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
      </div>
    </main>
  );
}

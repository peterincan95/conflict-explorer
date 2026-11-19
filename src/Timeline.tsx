import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { COPY } from "./copy";
import { monthName, type Month } from "./data";

/** Indexes into the month list. The range covers `from` up to, but not including, `to`. */
export type MonthRange = [from: number, to: number];

/** The stretch of days the track shows, from the epoch. */
export type DayView = [from: number, to: number];

type DragKind = "from" | "to" | "band";

/** One line on the chart. */
export interface ChartSeries {
  key: string;
  color: string;
  values: ArrayLike<number>;
}

/**
 * The months whose starts fall inside a view, as a range. `days` is each month's first
 * day, plus the end of the last month.
 */
function monthsInView(days: ArrayLike<number>, [start, end]: DayView): MonthRange {
  const lastMonth = days.length - 1;
  let from = 0;
  while (from < lastMonth && days[from]! < start - 0.5) from += 1;
  let to = lastMonth;
  while (to > 0 && days[to]! > end + 0.5) to -= 1;
  if (to <= from) return [Math.min(from, lastMonth - 1), Math.min(from, lastMonth - 1) + 1];
  return [from, to];
}

// The chart and month ticks share one SVG coordinate system, stretched to fit the track.
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;
const CHART_HEIGHT = 90;
const MONTH_TICK_HEIGHT = 9;
// Month ticks hide when closer than this, and year labels skip years to stay this far apart.
const MIN_MONTH_TICK_PIXELS = 3;
const MIN_YEAR_LABEL_PIXELS = 48;
const YEAR_LABEL_STEPS = [1, 2, 5, 10];
// Months get their own labels once each is this wide.
const MIN_MONTH_LABEL_PIXELS = 34;

// Zoom change per pixel of wheel movement, and the fewest days the track can show.
const WHEEL_SPEED = 0.002;
const PINCH_WHEEL_SPEED = 0.012;
const LINE_HEIGHT_PIXELS = 16;
export const MIN_VIEW_DAYS = 365;

const DOUBLE_PRESS_MS = 350;

interface Drag {
  kind: DragKind;
  startMonth: number;
  startRange: MonthRange;
}

/** Dragging the track to pan the view. */
interface Pan {
  startX: number;
  startView: DayView;
}

interface TimelineProps {
  /** Every month's start, plus one more for the end of the last month. */
  months: Month[];
  /** What the chart shows, by month. */
  series: ChartSeries[];
  /** One series filled underneath, or several as lines. */
  chartStyle: "area" | "lines";
  range: MonthRange;
  isFiltered: boolean;
  /** The days the track shows, zoomed by the wheel. */
  view: DayView;
  onViewChange: (view: DayView) => void;
  formatMonth: (month: number) => string;
  onChange: (range: MonthRange) => void;
  onReset: () => void;
  startHandle: RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  onToggle: (isOpen: boolean) => void;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * Plots each month's value at the middle of that month, scaled to the tallest month in
 * view. `toX` places a day across the chart.
 */
function chartPaths(
  days: number[],
  series: ChartSeries[],
  view: DayView,
  toX: (day: number) => number,
) {
  const middleDay = (month: number) => (days[month]! + days[month + 1]!) / 2;
  const monthCount = days.length - 1;
  // One month past each edge, so the line runs off the chart instead of stopping short.
  let first = 0;
  while (first < monthCount - 1 && middleDay(first + 1) < view[0]) first += 1;
  let last = monthCount - 1;
  while (last > 0 && middleDay(last - 1) > view[1]) last -= 1;
  let peak = 1;
  for (const { values } of series) {
    for (let month = first; month <= last; month += 1) {
      if (days[month + 1]! > view[0] && days[month]! < view[1]) peak = Math.max(peak, values[month]!);
    }
  }
  const bottom = `L${toX(middleDay(last))} ${VIEW_HEIGHT}L${toX(middleDay(first))} ${VIEW_HEIGHT}Z`;
  return series.map(({ key, color, values }) => {
    const points: string[] = [];
    for (let month = first; month <= last; month += 1) {
      points.push(`${toX(middleDay(month))} ${VIEW_HEIGHT - (values[month]! / peak) * CHART_HEIGHT}`);
    }
    const line = `M${points.join("L")}`;
    return { key, color, line, area: line + bottom };
  });
}

export function Timeline({
  months,
  series,
  chartStyle,
  range,
  isFiltered,
  view,
  onViewChange,
  formatMonth,
  onChange,
  onReset,
  startHandle,
  isOpen,
  onToggle,
}: TimelineProps) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const pan = useRef<Pan | null>(null);
  const lastPress = useRef(0);
  const [trackWidth, setTrackWidth] = useState(1000);
  const lastMonth = months.length - 1;
  const days = useMemo(() => months.map(({ day }) => day), [months]);
  const [viewFrom, viewTo] = view;
  const viewSpan = viewTo - viewFrom;
  const [from, to] = range;
  const share = (month: number) => (days[month]! - viewFrom) / viewSpan;
  // Handles and the band stop at the track's ends when the range runs past the view.
  const shownShare = (month: number) => clamp(share(month), 0, 1);
  const percent = (month: number) => `${shownShare(month) * 100}%`;
  const inView = (month: number) => share(month) >= 0 && share(month) <= 1;
  const isZoomed = viewFrom > days[0]! || viewTo < days[lastMonth]!;
  const canReset = isFiltered || isZoomed;
  const bandMiddle = ((shownShare(from) + shownShare(to)) / 2) * 100;

  // The newest view and callback, for the wheel listener.
  const latest = useRef({ view, onViewChange, days });
  latest.current = { view, onViewChange, days };

  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setTrackWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [isOpen]);

  // The wheel zooms around the pointer; sideways scrolling, or Shift with the wheel, pans.
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { view: current, onViewChange: change, days: allDays } = latest.current;
      const [start, end] = current;
      const first = allDays[0]!;
      const final = allDays.at(-1)!;
      const lineScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_HEIGHT_PIXELS : 1;
      const { left, width } = element.getBoundingClientRect();
      const span = end - start;
      const sideways = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX;
      const upDown = event.shiftKey ? 0 : event.deltaY;
      if (Math.abs(sideways) > Math.abs(upDown)) {
        const shift = clamp((sideways * lineScale * span) / width, first - start, final - end);
        if (shift !== 0) change([start + shift, end + shift]);
        return;
      }
      const speed = event.ctrlKey ? PINCH_WHEEL_SPEED : WHEEL_SPEED;
      const fullSpan = final - first;
      const nextSpan = clamp(
        span * Math.exp(upDown * lineScale * speed),
        Math.min(MIN_VIEW_DAYS, fullSpan),
        fullSpan,
      );
      const anchorShare = clamp((event.clientX - left) / width, 0, 1);
      const anchor = start + anchorShare * span;
      const nextStart = clamp(anchor - anchorShare * nextSpan, first, final - nextSpan);
      if (nextStart !== start || nextSpan !== span) change([nextStart, nextStart + nextSpan]);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [isOpen]);

  // January of each year, as an index into the month list.
  const yearStarts = useMemo(
    () => months.slice(0, -1).flatMap((month, index) => (month.month === 1 ? [index] : [])),
    [months],
  );
  const pixelsPerMonth = (trackWidth / viewSpan) * (365.25 / 12);
  const yearStep =
    YEAR_LABEL_STEPS.find((step) => pixelsPerMonth * 12 * step >= MIN_YEAR_LABEL_PIXELS) ??
    YEAR_LABEL_STEPS.at(-1)!;
  const visibleYears = yearStarts.filter(inView);
  const labeledYears = visibleYears.filter((index) => months[index]!.year % yearStep === 0);
  // Months that start in view, other than Januaries, which have their year.
  const labeledMonths =
    pixelsPerMonth >= MIN_MONTH_LABEL_PIXELS
      ? months
          .slice(0, -1)
          .flatMap((month, index) => (month.month !== 1 && inView(index) ? [index] : []))
      : [];

  const monthTicks = useMemo(() => {
    if (pixelsPerMonth < MIN_MONTH_TICK_PIXELS) return "";
    const ticks: string[] = [];
    for (let index = 1; index < lastMonth; index += 1) {
      const day = days[index]!;
      if (months[index]!.month === 1 || day < viewFrom || day > viewTo) continue;
      ticks.push(`M${((day - viewFrom) / viewSpan) * VIEW_WIDTH} 0V${MONTH_TICK_HEIGHT}`);
    }
    return ticks.join("");
  }, [days, months, lastMonth, pixelsPerMonth, viewFrom, viewTo, viewSpan]);
  const chart = useMemo(
    () => chartPaths(days, series, [viewFrom, viewTo], (day) => ((day - viewFrom) / viewSpan) * VIEW_WIDTH),
    [days, series, viewFrom, viewTo, viewSpan],
  );

  const nearestMonth = (clientX: number) => {
    const { left, width } = track.current!.getBoundingClientRect();
    const day = viewFrom + clamp((clientX - left) / width, 0, 1) * viewSpan;
    let nearest = 0;
    days.forEach((start, index) => {
      if (Math.abs(start - day) < Math.abs(days[nearest]! - day)) nearest = index;
    });
    return nearest;
  };

  const moved = (kind: DragKind, startRange: MonthRange, change: number): MonthRange => {
    const [startFrom, startTo] = startRange;
    if (kind === "from") return [clamp(startFrom + change, 0, startTo - 1), startTo];
    if (kind === "to") return [startFrom, clamp(startTo + change, startFrom + 1, lastMonth)];
    const shift = clamp(change, -startFrom, lastMonth - startTo);
    return [startFrom + shift, startTo + shift];
  };

  const startDrag = (kind: DragKind) => (event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    // Counted from presses, not dblclick, so it also works on touch screens.
    const isDoublePress = event.timeStamp - lastPress.current < DOUBLE_PRESS_MS;
    lastPress.current = event.timeStamp;
    if (isDoublePress && canReset) {
      lastPress.current = 0;
      onReset();
      return;
    }
    // A band filling a zoomed view has nowhere to move, so it pans.
    const [viewStart, viewEnd] = monthsInView(days, view);
    if (kind === "band" && isZoomed && from <= viewStart && to >= viewEnd) {
      startPan(event);
      return;
    }
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind, startMonth: nearestMonth(event.clientX), startRange: snappedRange(kind) };
  };

  /**
   * Moving a handle that sits past the edge of a zoomed view first brings both handles
   * inside it, so the drag starts from what's in view. Returns the range to move from.
   */
  const snappedRange = (kind: DragKind): MonthRange => {
    if (kind === "band") return range;
    const [viewStart, viewEnd] = monthsInView(days, view);
    const next: MonthRange = [Math.max(from, viewStart), Math.min(to, viewEnd)];
    if (next[1] <= next[0]) return range;
    if (next[0] !== from || next[1] !== to) onChange(next);
    return next;
  };

  const startPan = (event: PointerEvent<HTMLElement>) => {
    if (!isZoomed || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = { startX: event.clientX, startView: view };
  };

  // Presses on the track itself, not on the band or a handle.
  const startTrackPan = (event: PointerEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) startPan(event);
  };

  const onDrag = (event: PointerEvent) => {
    if (pan.current) {
      const { startX, startView } = pan.current;
      const span = startView[1] - startView[0];
      const width = track.current!.getBoundingClientRect().width;
      const shift = clamp(
        (-(event.clientX - startX) / width) * span,
        days[0]! - startView[0],
        days[lastMonth]! - startView[1],
      );
      onViewChange([startView[0] + shift, startView[1] + shift]);
      return;
    }
    if (!drag.current) return;
    const { kind, startMonth, startRange } = drag.current;
    const next = moved(kind, startRange, nearestMonth(event.clientX) - startMonth);
    if (next[0] !== from || next[1] !== to) onChange(next);
  };

  const endDrag = () => {
    drag.current = null;
    pan.current = null;
  };

  const onKeyDown = (kind: DragKind) => (event: KeyboardEvent) => {
    // Shift moves a year at a time.
    const step = event.shiftKey ? 12 : 1;
    const change = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[event.key];
    if (change === undefined) return;
    event.preventDefault();
    onChange(moved(kind, snappedRange(kind), change));
  };

  const handle = (kind: "from" | "to", month: number, label: string, valueMonth: number) => (
    <div
      className={`handle handle-${kind}`}
      ref={kind === "from" ? startHandle : undefined}
      style={{ left: percent(month) }}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={kind === "from" ? 0 : from + 1}
      aria-valuemax={kind === "from" ? to - 1 : lastMonth}
      aria-valuenow={month}
      aria-valuetext={formatMonth(valueMonth)}
      onPointerDown={startDrag(kind)}
      onPointerMove={onDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown(kind)}
    />
  );

  const rangeText = `${formatMonth(from)} – ${formatMonth(to - 1)}`;

  return (
    <section className={isOpen ? "timeline" : "timeline collapsed"} aria-label={COPY.timeline.title}>
      <div className="timeline-head">
        {/* One button for both states, so focus stays put when the timeline opens or closes. */}
        <button
          type="button"
          className="timeline-toggle"
          aria-expanded={isOpen}
          aria-controls="timeline-body"
          aria-label={isOpen ? COPY.timeline.hide : COPY.timeline.show}
          title={isOpen ? COPY.timeline.hide : COPY.timeline.show}
          onClick={() => onToggle(!isOpen)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d={isOpen ? "M3.5 6 8 10.5 12.5 6" : "M3.5 10 8 5.5 12.5 10"} />
          </svg>
          {!isOpen && <span>{COPY.timeline.title}</span>}
        </button>
        {isOpen && (
          <div className="range-pills">
            <button
              type="button"
              className="pill pill-icon"
              aria-label={COPY.timeline.reset}
              title={COPY.timeline.reset}
              disabled={!canReset}
              onClick={onReset}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 6.5a5 5 0 1 1-.2 3.2" />
                <path d="M3 2.5v4h4" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {isOpen && (
        <div id="timeline-body">
          <div className="range-row" aria-hidden="true">
            <span
              className="range-label"
              style={{ left: `clamp(80px, ${bandMiddle}%, calc(100% - 80px))` }}
            >
              {rangeText}
            </span>
          </div>
          <div
            className={isZoomed ? "track pannable" : "track"}
            ref={track}
            onPointerDown={startTrackPan}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div
              className={isFiltered ? "band band-filtered" : "band"}
              style={{ left: percent(from), right: `${100 - shownShare(to) * 100}%` }}
              onPointerDown={startDrag("band")}
              onPointerMove={onDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
            <svg
              className="chart"
              viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {chart.map(({ key, color, line, area }) =>
                chartStyle === "area" ? (
                  <g key={key}>
                    <path className="chart-area" d={area} style={{ fill: color }} />
                    <path className="chart-line" d={line} style={{ stroke: color }} />
                  </g>
                ) : (
                  <path key={key} className="chart-line chart-type-line" d={line} style={{ stroke: color }} />
                ),
              )}
              <path className="month-ticks" d={monthTicks} />
            </svg>
            {visibleYears.map((index) => (
              <div className="tick" key={index} style={{ left: percent(index) }} />
            ))}
            {handle("from", from, COPY.timeline.start, from)}
            {handle("to", to, COPY.timeline.end, to - 1)}
          </div>
          <div
            className={isZoomed ? "year-row pannable" : "year-row"}
            aria-hidden="true"
            onPointerDown={startPan}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {labeledYears.map((index) => (
              <span key={index} style={{ left: percent(index) }}>
                {months[index]!.year}
              </span>
            ))}
            {labeledMonths.map((index) => (
              <span className="month-label" key={index} style={{ left: percent(index) }}>
                {monthName(months[index]!.month)}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

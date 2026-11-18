import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { COPY } from "./copy";
import type { Month } from "./data";

/** Indexes into the month list. The range covers `from` up to, but not including, `to`. */
export type MonthRange = [from: number, to: number];

type DragKind = "from" | "to" | "band";

// The chart and month ticks share one SVG coordinate system, stretched to fit the track.
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;
const CHART_HEIGHT = 90;
const MONTH_TICK_HEIGHT = 9;
// Month ticks hide when closer than this, and year labels skip years to stay this far apart.
const MIN_MONTH_TICK_PIXELS = 3;
const MIN_YEAR_LABEL_PIXELS = 48;
const YEAR_LABEL_STEPS = [1, 2, 5, 10];

const DOUBLE_PRESS_MS = 350;

interface Drag {
  kind: DragKind;
  startMonth: number;
  startRange: MonthRange;
}

interface TimelineProps {
  /** Every month's start, plus one more for the end of the last month. */
  months: Month[];
  /** Each month's value for the chart. */
  monthlyValues: ArrayLike<number>;
  range: MonthRange;
  isFiltered: boolean;
  formatMonth: (month: number) => string;
  onChange: (range: MonthRange) => void;
  onReset: () => void;
  startHandle: RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  onToggle: (isOpen: boolean) => void;
  /** The color of the monthly count chart. */
  chartColor: string;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** Plots each month's value at the middle of that month. */
function chartPaths(days: number[], counts: ArrayLike<number>, span: number) {
  let peak = 1;
  for (let month = 0; month < counts.length; month += 1) peak = Math.max(peak, counts[month]!);
  const middle = (month: number) => ((days[month]! + days[month + 1]!) / 2 / span) * VIEW_WIDTH;
  const points = Array.from(counts, (count, month) => {
    return `${middle(month)} ${VIEW_HEIGHT - (count / peak) * CHART_HEIGHT}`;
  });
  const line = `M${points.join("L")}`;
  const lastX = middle(counts.length - 1);
  return { line, area: `${line}L${lastX} ${VIEW_HEIGHT}L${middle(0)} ${VIEW_HEIGHT}Z` };
}

export function Timeline({
  months,
  monthlyValues,
  range,
  isFiltered,
  formatMonth,
  onChange,
  onReset,
  startHandle,
  isOpen,
  onToggle,
  chartColor,
}: TimelineProps) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const lastPress = useRef(0);
  const [trackWidth, setTrackWidth] = useState(1000);
  const lastMonth = months.length - 1;
  const days = useMemo(() => months.map(({ day }) => day), [months]);
  const span = days[lastMonth]! - days[0]!;
  const [from, to] = range;
  const share = (month: number) => (days[month]! - days[0]!) / span;
  const percent = (month: number) => `${share(month) * 100}%`;
  const bandMiddle = ((share(from) + share(to)) / 2) * 100;

  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setTrackWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [isOpen]);

  // January of each year, as an index into the month list.
  const yearStarts = useMemo(
    () => months.slice(0, -1).flatMap((month, index) => (month.month === 1 ? [index] : [])),
    [months],
  );
  const yearStep =
    YEAR_LABEL_STEPS.find((step) => (trackWidth / (span / 365.25)) * step >= MIN_YEAR_LABEL_PIXELS) ??
    YEAR_LABEL_STEPS.at(-1)!;
  const labeledYears = yearStarts.filter((index) => months[index]!.year % yearStep === 0);

  const monthTicks = useMemo(() => {
    if (trackWidth / lastMonth < MIN_MONTH_TICK_PIXELS) return "";
    return days
      .slice(1, -1)
      .filter((_, index) => months[index + 1]!.month !== 1)
      .map((day) => `M${((day - days[0]!) / span) * VIEW_WIDTH} 0V${MONTH_TICK_HEIGHT}`)
      .join("");
  }, [days, months, span, lastMonth, trackWidth]);
  const chart = useMemo(
    () => chartPaths(days.map((day) => day - days[0]!), monthlyValues, span),
    [days, monthlyValues, span],
  );

  const nearestMonth = (clientX: number) => {
    const { left, width } = track.current!.getBoundingClientRect();
    const day = days[0]! + clamp((clientX - left) / width, 0, 1) * span;
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
    if (isDoublePress && isFiltered) {
      lastPress.current = 0;
      onReset();
      return;
    }
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind, startMonth: nearestMonth(event.clientX), startRange: range };
  };

  const onDrag = (event: PointerEvent) => {
    if (!drag.current) return;
    const { kind, startMonth, startRange } = drag.current;
    const next = moved(kind, startRange, nearestMonth(event.clientX) - startMonth);
    if (next[0] !== from || next[1] !== to) onChange(next);
  };

  const endDrag = () => {
    drag.current = null;
  };

  const onKeyDown = (kind: DragKind) => (event: KeyboardEvent) => {
    // Shift moves a year at a time.
    const step = event.shiftKey ? 12 : 1;
    const change = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[event.key];
    if (change === undefined) return;
    event.preventDefault();
    onChange(moved(kind, range, change));
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
          <>
            <h2 className="timeline-title">{COPY.timeline.title}</h2>
            <div className="range-pills">
              <button
                type="button"
                className="pill pill-icon"
                aria-label={COPY.timeline.reset}
                title={COPY.timeline.reset}
                disabled={!isFiltered}
                onClick={onReset}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.5 6.5a5 5 0 1 1-.2 3.2" />
                  <path d="M3 2.5v4h4" />
                </svg>
              </button>
            </div>
          </>
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
          <div className="track" ref={track}>
            <div
              className={isFiltered ? "band band-filtered" : "band"}
              style={{ left: percent(from), right: `${100 - share(to) * 100}%` }}
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
              <path className="chart-area" d={chart.area} style={{ fill: chartColor }} />
              <path className="chart-line" d={chart.line} style={{ stroke: chartColor }} />
              <path className="month-ticks" d={monthTicks} />
            </svg>
            {yearStarts.slice(1).map((index) => (
              <div className="tick" key={index} style={{ left: percent(index) }} />
            ))}
            {handle("from", from, COPY.timeline.start, from)}
            {handle("to", to, COPY.timeline.end, to - 1)}
          </div>
          <div className="year-row" aria-hidden="true">
            {labeledYears.map((index) => (
              <span key={index} style={{ left: percent(index) }}>
                {months[index]!.year}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

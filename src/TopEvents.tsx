import { useRef, type KeyboardEvent } from "react";
import { COPY } from "./copy";

export interface TopEvent {
  /** The event's index in the data. */
  index: number;
  place: string;
  date: string;
  /** Deaths, as a number or a range, ready to show. */
  fatalities: string;
  /** The event's type color, when points are colored by type. */
  color: string | null;
}

interface TopEventsProps {
  isOpen: boolean;
  onToggle: (isOpen: boolean) => void;
  /** The deadliest events under the filters, most deaths first. */
  events: TopEvent[];
  /** Whether more events match than the list shows. */
  hasMore: boolean;
  onShowMore: () => void;
  /** Rings an event on the map, or clears the ring. */
  onHighlight: (index: number | null) => void;
  /** Flies the map to an event. */
  onSelect: (index: number) => void;
}

/** A column down the right of the screen listing the deadliest events under the filters. */
export function TopEvents({
  isOpen,
  onToggle,
  events,
  hasMore,
  onShowMore,
  onHighlight,
  onSelect,
}: TopEventsProps) {
  const toggle = useRef<HTMLButtonElement>(null);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !isOpen) return;
    onToggle(false);
    toggle.current?.focus();
  };

  return (
    <aside
      className={isOpen ? "side-panel open" : "side-panel"}
      aria-label={COPY.topEvents.title}
      onKeyDown={onKeyDown}
    >
      {/* One button for both states, so focus stays put when the panel opens or closes. */}
      <button
        type="button"
        className="side-toggle"
        ref={toggle}
        aria-expanded={isOpen}
        aria-controls="side-body"
        aria-label={isOpen ? COPY.topEvents.hide : COPY.topEvents.show}
        title={isOpen ? COPY.topEvents.hide : COPY.topEvents.show}
        onClick={() => onToggle(!isOpen)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d={isOpen ? "M6 3.5 10.5 8 6 12.5" : "M10 3.5 5.5 8 10 12.5"} />
        </svg>
        {!isOpen && <span className="side-rail-label">{COPY.topEvents.title}</span>}
      </button>

      {isOpen && (
        <div className="side-body" id="side-body">
          <h2 className="side-head">{COPY.topEvents.title}</h2>
          {events.length > 0 ? (
            <div className="side-scroll">
              <ol className="side-list" onMouseLeave={() => onHighlight(null)}>
                {events.map(({ index, place, date, fatalities, color }) => (
                  <li key={index}>
                    <button
                      type="button"
                      className="side-row"
                      title={COPY.topEvents.zoomTo}
                      onMouseEnter={() => onHighlight(index)}
                      onFocus={() => onHighlight(index)}
                      onBlur={() => onHighlight(null)}
                      onClick={() => onSelect(index)}
                    >
                    <span className="side-row-head">
                      <span className="side-name">
                        {color && <span className="swatch" style={{ background: color }} aria-hidden="true" />}
                        {place}
                      </span>
                      <span className="side-count">{fatalities}</span>
                    </span>
                    <span className="side-date">{date}</span>
                    </button>
                  </li>
                ))}
              </ol>
              {hasMore && (
                <button type="button" className="side-more" onClick={onShowMore}>
                  {COPY.topEvents.showMore}
                </button>
              )}
            </div>
          ) : (
            <p className="side-empty">{COPY.empty}</p>
          )}
        </div>
      )}
    </aside>
  );
}

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { COPY } from "./copy";
import { formatDays, loadSource, type Details, type EventData, type ViolenceType } from "./data";
import { formatDeaths, formatSource, formatToll, numberFormat, placeName } from "./format";
import type { MapView } from "./mapView";
import { TYPE_COLORS } from "./renderer";

// The popup sits this far from the clicked spot, in CSS pixels, and at least this far
// inside the map's edges.
const SPOT_GAP = 14;
const EDGE_GAP = 8;
const PROVISIONAL = 1;
// Citations longer than this many characters start cut to a few lines, with a toggle.
const LONG_SOURCE = 180;

interface EventPopupProps {
  data: EventData;
  details: Details | null;
  /** The events under the click, deadliest first. */
  events: number[];
  /** The clicked spot, in grid units. */
  spot: { x: number; y: number };
  mapView: MapView;
  isRange: boolean;
  colorByType: boolean;
  /** Called with the event on show, to ring it on the map. */
  onShow: (index: number) => void;
  onSelectConflict: (id: number) => void;
  onSelectActor: (id: number) => void;
  onClose: () => void;
}

/** A card beside a clicked spot on the map, describing the events there one at a time. */
export function EventPopup({
  data,
  details,
  events,
  spot,
  mapView,
  isRange,
  colorByType,
  onShow,
  onSelectConflict,
  onSelectActor,
  onClose,
}: EventPopupProps) {
  const [position, setPosition] = useState(0);
  const [isListOpen, setIsListOpen] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [isSourceOpen, setIsSourceOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { meta, attrs } = data;
  const index = events[position]!;
  const count = events.length;

  // Follows the spot as the map moves, flipping to its other side or sliding along
  // the map's edge where there's no room.
  useLayoutEffect(() => {
    const card = root.current!;
    const place = () => {
      // Stays in the open part of the map, clear of the header and timeline.
      const open = mapView.openArea;
      const { x, y } = mapView.toScreen(spot.x, spot.y);
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      const minLeft = open.left + EDGE_GAP;
      const maxLeft = open.left + open.width - width - EDGE_GAP;
      let left = x + SPOT_GAP;
      if (left > maxLeft) left = x - SPOT_GAP - width;
      left = Math.max(Math.min(left, maxLeft), minLeft);
      const minTop = open.top + EDGE_GAP;
      const top = Math.max(Math.min(y - height / 2, open.top + open.height - height - EDGE_GAP), minTop);
      card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      card.style.maxHeight = `${Math.max(open.height - 2 * EDGE_GAP, 160)}px`;
    };
    place();
    const stopMoving = mapView.onMove(place);
    const observer = new ResizeObserver(place);
    observer.observe(card);
    if (card.offsetParent) observer.observe(card.offsetParent);
    return () => {
      stopMoving();
      observer.disconnect();
    };
  }, [mapView, spot]);

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [events]);

  // Escape closes the popup wherever focus is, unless the list is open, which it closes first.
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isListOpen) setIsListOpen(false);
      else onClose();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [isListOpen, onClose]);

  useEffect(() => {
    onShow(index);
  }, [index, onShow]);

  useEffect(() => {
    let isCurrent = true;
    setSource(null);
    setIsSourceOpen(false);
    loadSource(meta, index)
      .then((text) => {
        if (isCurrent) setSource(formatSource(text));
      })
      .catch(() => {
        if (isCurrent) setSource("");
      });
    return () => {
      isCurrent = false;
    };
  }, [meta, index]);

  const show = (next: number) => {
    setPosition((next + count) % count);
    setIsListOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isListOpen && count > 1 && event.key === "ArrowLeft") {
      show(position - 1);
    } else if (!isListOpen && count > 1 && event.key === "ArrowRight") {
      show(position + 1);
    }
  };

  const tollOf = (event: number) => {
    const best = data.best[event]!;
    return { best, low: details?.low[event] ?? best, high: details?.high[event] ?? best };
  };
  const placeOf = (event: number) =>
    placeName(details?.places[details.place[event]!], meta.countries[attrs.country[event]!]!.name);
  const typeOf = (event: number) => attrs.type[event] as ViolenceType;

  const toll = tollOf(index);
  const isOne = (isRange ? toll.high : toll.best) === 1;
  const sideA = attrs.sideA[index]!;
  const sideB = attrs.sideB[index]!;
  const summary = COPY.popup.summary(
    COPY.popup.types[typeOf(index)],
    (text, kind) => {
      const select =
        kind === "conflict"
          ? () => onSelectConflict(attrs.conflict[index]!)
          : () => onSelectActor(kind === "sideA" ? sideA : sideB);
      return (
        <button key={kind} type="button" className="popup-link" onClick={select}>
          {text}
        </button>
      );
    },
    meta.actors[sideA]!,
    meta.actors[sideB]!,
    formatToll(toll, isRange, numberFormat.format),
    isRange && toll.low !== toll.high,
    isOne,
  );
  const isProvisional = (attrs.flags[index]! & PROVISIONAL) !== 0;
  const isLongSource = (source?.length ?? 0) > LONG_SOURCE;

  return (
    <div
      className="popup"
      ref={root}
      role="dialog"
      aria-label={COPY.popup.label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="popup-head">
        {count > 1 && (
          <button
            type="button"
            className="popup-list-button"
            aria-expanded={isListOpen}
            title={isListOpen ? COPY.popup.hideList : COPY.popup.showList}
            onClick={() => setIsListOpen(!isListOpen)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span className="visually-hidden">{COPY.popup.showList}: </span>
            {COPY.popup.position(position + 1, count)}
          </button>
        )}
        <div className="popup-actions">
          {count > 1 && !isListOpen && (
            <>
              <button
                type="button"
                className="popup-icon"
                aria-label={COPY.popup.previous}
                title={COPY.popup.previous}
                onClick={() => show(position - 1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              <button
                type="button"
                className="popup-icon"
                aria-label={COPY.popup.next}
                title={COPY.popup.next}
                onClick={() => show(position + 1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </>
          )}
          <button
            type="button"
            className="popup-icon"
            aria-label={COPY.popup.close}
            title={COPY.popup.close}
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      {isListOpen ? (
        <div className="popup-scroll">
          <p className="visually-hidden">{COPY.popup.listTitle(numberFormat.format(count))}</p>
          <ol className="popup-list">
            {events.map((event, at) => {
              const eventToll = tollOf(event);
              return (
                <li key={event}>
                  <button
                    type="button"
                    className="popup-row"
                    aria-current={at === position ? "true" : undefined}
                    onClick={() => show(at)}
                  >
                    <span className="popup-row-head">
                      <span className="popup-row-place">
                        {colorByType && (
                          <span className="swatch" style={{ background: TYPE_COLORS[typeOf(event)] }} />
                        )}
                        {placeOf(event)}
                      </span>
                      <span className="popup-row-count">
                        {COPY.popup.deaths(
                          formatToll(eventToll, isRange, formatDeaths),
                          (isRange ? eventToll.high : eventToll.best) === 1,
                        )}
                      </span>
                    </span>
                    <span className="popup-row-date">
                      {formatDays(meta.epoch, data.start[event]!, data.end[event]!)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <div className="popup-body">
          <div className="popup-facts">
            <p className="popup-fact">{formatDays(meta.epoch, data.start[index]!, data.end[index]!)}</p>
            <p className="popup-fact">{placeOf(index)}</p>
          </div>
          <div className="popup-details">
            <p className="popup-summary">{summary}</p>
            <p className={isLongSource && !isSourceOpen ? "popup-source clamped" : "popup-source"}>
              {COPY.popup.source}{" "}
              {source === null ? COPY.popup.loadingSource : source || COPY.popup.noSource}
            </p>
            {isLongSource && (
              <button
                type="button"
                className="popup-more"
                aria-expanded={isSourceOpen}
                onClick={() => setIsSourceOpen(!isSourceOpen)}
              >
                {isSourceOpen ? COPY.popup.lessSource : COPY.popup.moreSource}
              </button>
            )}
            {isProvisional && <p className="popup-source">{COPY.popup.provisional}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

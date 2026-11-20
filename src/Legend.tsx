import { useEffect, useState, type RefObject } from "react";
import { COPY } from "./copy";
import { VIOLENCE_TYPES } from "./data";
import type { MapView } from "./mapView";
import { DEFAULT_GRADIENT, pointWidth, TYPE_COLORS } from "./renderer";

// Death counts the size key can show, and the widest circle it shows, in pixels.
// It shows the largest few that fit, so the key stays small as points grow with zoom.
const SIZE_STEPS = [1, 10, 100, 1_000, 10_000, 100_000];
const MAX_KEY_SIZE = 56;
const KEY_STEPS = 4;

const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact" });

interface LegendProps {
  mapView: RefObject<MapView | null>;
  colorByType: boolean;
  isOpen: boolean;
  onToggle: (isOpen: boolean) => void;
}

/** The key to the map: point sizes by deaths, and colors by type of violence when they're on. */
export function Legend({ mapView, colorByType, isOpen, onToggle }: LegendProps) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const view = mapView.current;
    if (!view) return;
    setZoom(view.zoom);
    return view.onZoom(setZoom);
  }, [mapView]);

  const steps = SIZE_STEPS.map((deaths) => ({ deaths, width: pointWidth(deaths, zoom) }))
    .filter(({ width }) => width <= MAX_KEY_SIZE)
    .slice(-KEY_STEPS);
  const tallest = Math.max(...steps.map(({ width }) => width));
  const fill = colorByType ? undefined : DEFAULT_GRADIENT[2];

  return (
    <aside className={isOpen ? "legend" : "legend collapsed"} aria-label={COPY.legend.title}>
      {/* Collapsed, the legend shrinks to a pill holding this toggle, like the timeline. */}
      <button
        type="button"
        className="legend-toggle"
        aria-expanded={isOpen}
        aria-controls="legend-body"
        title={isOpen ? COPY.legend.hide : COPY.legend.show}
        onClick={() => onToggle(!isOpen)}
      >
        <span>{COPY.legend.title}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d={isOpen ? "M3.5 6 8 10.5 12.5 6" : "M3.5 10 8 5.5 12.5 10"} />
        </svg>
      </button>
      {isOpen && (
        <div className="legend-body" id="legend-body">
          {colorByType && (
            <ul className="legend-types">
              {VIOLENCE_TYPES.map((type) => (
                <li key={type}>
                  <span className="swatch" style={{ background: TYPE_COLORS[type] }} aria-hidden="true" />
                  {COPY.legend.types[type]}
                </li>
              ))}
            </ul>
          )}
          <p className="legend-title">{COPY.legend.size}</p>
          <ul className="legend-sizes">
            {steps.map(({ deaths, width }) => (
              <li key={deaths}>
                <span className="legend-dot-box" style={{ height: tallest }} aria-hidden="true">
                  <span
                    className="legend-dot"
                    style={{ width, height: width, ...(fill ? { background: fill } : {}) }}
                  />
                </span>
                <span>{compactFormat.format(deaths)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

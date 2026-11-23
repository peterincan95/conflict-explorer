import { useEffect, useRef, useState } from "react";
import { COPY } from "./copy";
import type { ConflictView } from "./views";

interface ViewSelectorProps {
  views: ConflictView[];
  /** The view showing, or null for the world map. */
  current: ConflictView | null;
  onSelect: (id: string | null) => void;
}

/** A globe outline, for the world map. */
function GlobeIcon() {
  return (
    <svg className="view-icon globe-icon" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="17" />
      <ellipse cx="20" cy="20" rx="7.5" ry="17" />
      <path d="M3 20h34M6 11h28M6 29h28M20 3v34" />
    </svg>
  );
}

function CountryIcon({ icon }: { icon: ConflictView["icon"] }) {
  return (
    <svg className="view-icon country-icon" viewBox={`0 0 ${icon.width} ${icon.height}`} aria-hidden="true">
      <path d={icon.d} />
    </svg>
  );
}

/**
 * A tile showing which map is up, at the map's bottom right. Pressing it opens the
 * other maps beside it: the world, and each conflict view.
 */
export function ViewSelector({ views, current, onSelect }: ViewSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const tile = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      tile.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  const choices = [
    ...(current ? [{ id: null, name: COPY.views.global, icon: <GlobeIcon /> }] : []),
    ...views
      .filter((view) => view.id !== current?.id)
      .map((view) => ({ id: view.id, name: view.name, icon: <CountryIcon icon={view.icon} /> })),
  ];

  return (
    <div className="view-selector" ref={root}>
      {isOpen && (
        <div className="view-panel" id="view-choices" role="group" aria-label={COPY.views.choices}>
          {choices.map((choice) => (
            <button
              key={choice.id ?? "global"}
              type="button"
              className="view-choice"
              onClick={() => {
                setIsOpen(false);
                onSelect(choice.id);
              }}
            >
              {choice.icon}
              <span>{choice.name}</span>
            </button>
          ))}
        </div>
      )}
      <button
        ref={tile}
        type="button"
        className="view-tile glass"
        aria-expanded={isOpen}
        aria-controls="view-choices"
        aria-label={COPY.views.change(current?.name ?? COPY.views.global)}
        title={COPY.views.change(current?.name ?? COPY.views.global)}
        onClick={() => setIsOpen(!isOpen)}
      >
        {current ? <CountryIcon icon={current.icon} /> : <GlobeIcon />}
        <span>{current?.name ?? COPY.views.global}</span>
      </button>
    </div>
  );
}

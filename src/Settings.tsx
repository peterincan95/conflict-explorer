import { useEffect, useId, useRef, useState } from "react";
import { COPY } from "./copy";

export type FatalityMode = "best" | "range";

/** The map's on-off options. */
export interface MapToggles {
  colorByType: boolean;
  hillshade: boolean;
  places: boolean;
  labels: boolean;
}

interface SettingsProps {
  fatalityMode: FatalityMode;
  onFatalityModeChange: (mode: FatalityMode) => void;
  toggles: MapToggles;
  onTogglesChange: (toggles: MapToggles) => void;
}

const TOGGLE_ORDER: (keyof MapToggles)[] = ["colorByType", "hillshade", "places", "labels"];

/** A gear button that opens the map's display options. */
export function Settings({ fatalityMode, onFatalityModeChange, toggles, onTogglesChange }: SettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const groupId = useId();

  // Closes on a press outside, or on Escape.
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  const modes: [FatalityMode, string][] = [
    ["best", COPY.settings.best],
    ["range", COPY.settings.range],
  ];

  return (
    <div className="settings" ref={root}>
      <button
        type="button"
        className="pill pill-icon settings-button"
        ref={button}
        aria-label={COPY.settings.button}
        title={COPY.settings.button}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setIsOpen(!isOpen)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      {isOpen && (
        <div className="settings-panel" id={panelId} role="group" aria-label={COPY.settings.button}>
          <div className="settings-option">
            <span className="settings-label" id={groupId}>
              {COPY.settings.fatalities}
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby={groupId}>
              {modes.map(([mode, name]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={fatalityMode === mode}
                  onClick={() => onFatalityModeChange(mode)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          {TOGGLE_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              className="settings-option settings-switch"
              role="switch"
              aria-checked={toggles[key]}
              onClick={() => onTogglesChange({ ...toggles, [key]: !toggles[key] })}
            >
              <span className="settings-label">{COPY.settings[key]}</span>
              <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb" />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef } from "react";
import { COPY } from "./copy";

interface InfoPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * What the data is and how to use the map, open when the app starts. A modal dialog,
 * so Escape and a press outside close it, and focus stays inside while it's open.
 */
export function InfoPanel({ isOpen, onClose }: InfoPanelProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (isOpen && !element.open) element.showModal();
    if (!isOpen && element.open) element.close();
  }, [isOpen]);

  return (
    <dialog
      ref={dialog}
      className="info-panel"
      aria-labelledby="info-title"
      onClose={onClose}
      // A press on the backdrop lands on the dialog itself, outside its content.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="info-content">
        <div className="info-head">
          <h2 id="info-title">{COPY.info.title}</h2>
          <button type="button" className="info-close" aria-label={COPY.info.close} title={COPY.info.close} onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <p className="info-about">{COPY.info.about}</p>
        <ul className="info-steps">
          {COPY.info.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
        <button type="button" className="pill info-start" onClick={onClose}>
          {COPY.info.start}
        </button>
      </div>
    </dialog>
  );
}

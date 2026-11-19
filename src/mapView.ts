import type { Box } from "./box";
import type { Basemap, MapLabel, Meta } from "./data";
import { HOME, isHome, PanZoom } from "./panZoom";
import type { EventPicker } from "./picking";
import { MAP_MAX_ZOOM, mapLayout, pointWidth, type EventRenderer, type MapFrame } from "./renderer";
import { GRID_MAX, WHOLE_WORLD, type Area } from "./selection";

const MAX_PIXEL_RATIO = 2;
const BOX_LINE = "#e8e8e8";

// A label shows once the map is zoomed in as far as a web map at its zoom, less this
// bias, and only where it doesn't overlap a label already placed.
const LABEL_ZOOM_BIAS = 0.2;
// Labels also go no further than this zoom at the home view, rising as the map zooms
// in, so a wide screen doesn't name small countries before the user zooms in.
const HOME_LABEL_ZOOM = 2;
// Web map tiles are this many pixels wide at zoom 0.
const WEB_TILE_PIXELS = 256;
const LABEL_HALO = "rgb(0 0 0 / 70%)";
const LABEL_GAP = 4;

/** How one kind of label looks. */
interface LabelStyle {
  font: string;
  color: string;
  letterSpacing: string;
  lineHeight: number;
  uppercase: boolean;
  /** Names wrap onto more lines past this width, in CSS pixels. */
  wrapWidth: number;
}

const COUNTRY_STYLE: LabelStyle = {
  font: '700 12px "Roboto Condensed", sans-serif',
  color: "#7a7a7a",
  letterSpacing: "0.4px",
  lineHeight: 14,
  uppercase: true,
  wrapWidth: 84,
};
const PROVINCE_STYLE: LabelStyle = {
  font: '500 10.5px "Roboto Condensed", sans-serif',
  color: "#5c5c5c",
  letterSpacing: "0.6px",
  lineHeight: 12,
  uppercase: true,
  wrapWidth: 72,
};
const PLACE_STYLE: LabelStyle = {
  font: '400 12.5px "Roboto Condensed", sans-serif',
  color: "#b4b4b4",
  letterSpacing: "0px",
  lineHeight: 14,
  uppercase: false,
  wrapWidth: 96,
};
// Places get a small ring, with their name this far to its right.
const PLACE_RING_RADIUS = 2.5;
const PLACE_RING_COLOR = "#b4b4b4";
const PLACE_NAME_OFFSET = 5;

/** A label ready to draw: its name split into lines, and the widest line's width. */
interface MeasuredLabel {
  label: MapLabel;
  lines: string[];
  width: number;
}

// Fitting the map to an area leaves this share of the view around it, and stops
// at this zoom so a single town keeps some of its surroundings.
const FIT_PADDING = 1.25;
const MAX_FIT_ZOOM = 24;
// Picking an event flies at least this close to it.
const FOCUS_ZOOM = 16;
const HIGHLIGHT_RING = "rgb(255 255 255 / 85%)";
const HIGHLIGHT_HALO = "rgb(0 0 0 / 60%)";
const HIGHLIGHT_GAP = 3;
// Pointing at events and opening them works from this web map zoom in, about where a
// country fills the map.
export const PICK_MIN_ZOOM = 5;
// A press that moves less than this many CSS pixels is a click, not a drag.
const CLICK_SLOP = 5;

/** An event to ring on the map, in grid units. */
export interface Highlight {
  x: number;
  y: number;
  deaths: number;
}

/** What MapView tells its owner about pointing at events. */
export interface PickHandlers {
  /** The events under a click, deadliest first, and the clicked spot in grid units. */
  onPick: (events: number[], spot: { x: number; y: number }) => void;
  /** A click on the map away from any event. */
  onMiss: () => void;
}

interface ScreenBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlapsAny = (box: ScreenBox, placed: ScreenBox[]) =>
  placed.some(
    (other) =>
      box.left < other.right &&
      box.right > other.left &&
      box.top < other.bottom &&
      box.bottom > other.top,
  );

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * The map's camera: pans and zooms with the pointer, tells the renderer where to
 * draw the events, and draws the box on a canvas above them.
 */
export class MapView {
  private view: PanZoom;
  private width = 1;
  private height = 1;
  private fill: [number, number] = [1, 1];
  /** Where the camera's center sits, as a share of the panel across and down. */
  private center: [number, number] = [0.5, 0.5];
  private openFrame: MapFrame | null = null;
  private pixelRatio = 1;
  private area = WHOLE_WORLD;
  private frame = 0;
  private context: CanvasRenderingContext2D;
  private basemap: Basemap | null = null;
  /** Labels by kind, wrapped and measured once the font has loaded. */
  private countries: MeasuredLabel[] = [];
  private provinces: MeasuredLabel[] = [];
  private places: MeasuredLabel[] = [];
  private showLabels = true;
  private showPlaces = true;
  private highlight: Highlight | null = null;
  private hovered: Highlight | null = null;
  private zoomListeners = new Set<(zoom: number) => void>();
  private moveListeners = new Set<() => void>();
  private picker: EventPicker | null = null;
  private pickHandlers: PickHandlers | null = null;
  private isPanEnabled = true;
  private pressedAt: { x: number; y: number } | null = null;

  constructor(
    private plot: HTMLElement,
    private canvas: HTMLCanvasElement,
    private renderer: EventRenderer,
    private extent: Meta["extent"],
    onMovedChange: (isMoved: boolean) => void,
  ) {
    this.context = canvas.getContext("2d")!;
    this.view = new PanZoom(plot, -1, MAP_MAX_ZOOM, (camera) => {
      renderer.setCamera(camera);
      this.requestDraw();
      onMovedChange(!isHome(camera));
      this.zoomListeners.forEach((listener) => listener(camera.zoom));
      this.moveListeners.forEach((listener) => listener());
      // The map moved under a still pointer, so what it points at may have changed.
      this.setHovered(null);
    });
    plot.addEventListener("pointermove", this.onPointerMove);
    plot.addEventListener("pointerleave", this.onPointerLeave);
    plot.addEventListener("pointerdown", this.onPointerDown);
    plot.addEventListener("click", this.onClick);
    // Label widths depend on the web font.
    void document.fonts.ready.then(() => {
      this.measureLabels();
      this.requestDraw();
    });
  }

  get zoom() {
    return this.view.camera.zoom;
  }

  /** Calls `listener` with each new zoom. Returns a function that stops it. */
  onZoom(listener: (zoom: number) => void) {
    this.zoomListeners.add(listener);
    return () => {
      this.zoomListeners.delete(listener);
    };
  }

  /** Calls `listener` whenever the map pans or zooms. Returns a function that stops it. */
  onMove(listener: () => void) {
    this.moveListeners.add(listener);
    return () => {
      this.moveListeners.delete(listener);
    };
  }

  /** Lets the pointer find events, and says what to do when it clicks them. */
  setPicking(picker: EventPicker, handlers: PickHandlers) {
    this.picker = picker;
    this.pickHandlers = handlers;
  }

  /** The web map zoom the map is at, which doesn't depend on the screen's size. */
  get webZoom() {
    return Math.log2((this.width * this.fill[0] * this.view.camera.zoom) / WEB_TILE_PIXELS);
  }

  /** Where a spot in grid units sits on screen, in CSS pixels from the map's top left. */
  toScreen(x: number, y: number) {
    const { width, height, fill } = this;
    const { camera } = this.view;
    return {
      x: width * this.center[0] + (x / GRID_MAX - camera.x) * width * fill[0] * camera.zoom,
      y: height * this.center[1] - (y / GRID_MAX - camera.y) * height * fill[1] * camera.zoom,
    };
  }

  /** The events under a spot on screen, in CSS pixels from the map's top left. */
  private eventsAt(screenX: number, screenY: number) {
    const { picker, width, height, fill } = this;
    if (!picker || this.webZoom < PICK_MIN_ZOOM) return [];
    const { camera } = this.view;
    const scaleX = (width * fill[0] * camera.zoom) / GRID_MAX;
    const scaleY = (height * fill[1] * camera.zoom) / GRID_MAX;
    const x = (camera.x + (screenX - width * this.center[0]) / (width * fill[0] * camera.zoom)) * GRID_MAX;
    const y = (camera.y - (screenY - height * this.center[1]) / (height * fill[1] * camera.zoom)) * GRID_MAX;
    return picker.at(x, y, scaleX, scaleY, camera.zoom);
  }

  private localPoint(event: PointerEvent | MouseEvent) {
    const { left, top } = this.plot.getBoundingClientRect();
    return { x: event.clientX - left, y: event.clientY - top };
  }

  private setHovered(index: number | null) {
    const data = this.picker?.data;
    const next = index === null || !data ? null : { x: data.x[index]!, y: data.y[index]!, deaths: data.best[index]! };
    if (next?.x === this.hovered?.x && next?.y === this.hovered?.y && next?.deaths === this.hovered?.deaths) return;
    this.hovered = next;
    this.plot.classList.toggle("over-event", next !== null);
    this.requestDraw();
  }

  private onPointerMove = (event: PointerEvent) => {
    // No hovering while dragging, drawing a box or on touch screens.
    if (event.buttons !== 0 || !this.isPanEnabled || event.pointerType === "touch") {
      this.setHovered(null);
      return;
    }
    const { x, y } = this.localPoint(event);
    this.setHovered(this.eventsAt(x, y)[0] ?? null);
  };

  private onPointerLeave = () => this.setHovered(null);

  private onPointerDown = (event: PointerEvent) => {
    this.pressedAt = { x: event.clientX, y: event.clientY };
  };

  private onClick = (event: MouseEvent) => {
    const pressed = this.pressedAt;
    this.pressedAt = null;
    if (!this.isPanEnabled || !this.pickHandlers) return;
    if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > CLICK_SLOP) return;
    const { x, y } = this.localPoint(event);
    const events = this.eventsAt(x, y);
    if (events.length === 0) {
      this.pickHandlers.onMiss();
      return;
    }
    const { width, height, fill } = this;
    const { camera } = this.view;
    this.pickHandlers.onPick(events, {
      x: (camera.x + (x - width * this.center[0]) / (width * fill[0] * camera.zoom)) * GRID_MAX,
      y: (camera.y - (y - height * this.center[1]) / (height * fill[1] * camera.zoom)) * GRID_MAX,
    });
  };

  setBasemap(basemap: Basemap) {
    this.basemap = basemap;
    this.measureLabels();
    this.requestDraw();
  }

  /** Shows or hides country and province names. */
  setLabelsVisible(isVisible: boolean) {
    this.showLabels = isVisible;
    this.requestDraw();
  }

  /** Shows or hides populated places. */
  setPlacesVisible(isVisible: boolean) {
    this.showPlaces = isVisible;
    this.requestDraw();
  }

  private measureLabels() {
    const { basemap } = this;
    if (!basemap) return;
    this.countries = this.measure(basemap.countries, COUNTRY_STYLE);
    this.provinces = this.measure(basemap.provinces, PROVINCE_STYLE);
    this.places = this.measure(basemap.places, PLACE_STYLE);
  }

  /** Splits each name into lines no wider than the style's wrap width, where it can. */
  private measure(labels: MapLabel[], style: LabelStyle): MeasuredLabel[] {
    const { context } = this;
    this.applyStyle(style);
    return labels.map((label) => {
      const name = style.uppercase ? label.name.toUpperCase() : label.name;
      const lines: string[] = [];
      for (const word of name.split(" ")) {
        const last = lines.at(-1);
        if (last !== undefined && context.measureText(`${last} ${word}`).width <= style.wrapWidth) {
          lines[lines.length - 1] = `${last} ${word}`;
        } else {
          lines.push(word);
        }
      }
      const width = Math.max(...lines.map((line) => context.measureText(line).width));
      return { label, lines, width };
    });
  }

  private applyStyle(style: LabelStyle) {
    const { context } = this;
    context.font = style.font;
    context.letterSpacing = style.letterSpacing;
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.view.destroy();
    this.plot.removeEventListener("pointermove", this.onPointerMove);
    this.plot.removeEventListener("pointerleave", this.onPointerLeave);
    this.plot.removeEventListener("pointerdown", this.onPointerDown);
    this.plot.removeEventListener("click", this.onClick);
  }

  setLayout(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.canvas.width = Math.max(1, Math.round(width * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(height * this.pixelRatio));
    this.updateLayout();
  }

  /**
   * The part of the panel left open by the panels floating over it, in CSS pixels. The
   * world fits it at the home view, and filters and flights center in it.
   */
  setFrame(frame: MapFrame | null) {
    this.openFrame = frame;
    this.renderer.setFrame(frame);
    this.updateLayout();
  }

  /** The open part of the panel, in CSS pixels. */
  get openArea(): MapFrame {
    return this.openFrame ?? { left: 0, top: 0, width: this.width, height: this.height };
  }

  private updateLayout() {
    const { fill, center } = mapLayout(this.extent, this.width, this.height, this.openFrame);
    this.fill = fill;
    this.center = center;
    this.view.setLayout(this.width, this.height, fill, center);
    this.requestDraw();
  }

  setArea(area: Area) {
    this.area = area;
    this.requestDraw();
  }

  /** Panning gives way to drawing a box. */
  setPanEnabled(isEnabled: boolean) {
    this.isPanEnabled = isEnabled;
    this.view.setPanEnabled(isEnabled);
    if (!isEnabled) this.setHovered(null);
  }

  resetView() {
    this.view.reset();
  }

  /** Flies to show an area, in grid units, or back to the whole map. */
  fitTo(area: Area | null) {
    if (!area) {
      this.view.flyTo(HOME);
      return;
    }
    const { fill, width, height } = this;
    const open = this.openArea;
    const spanX = Math.max(area.east - area.west, 1) / GRID_MAX;
    const spanY = Math.max(area.north - area.south, 1) / GRID_MAX;
    const zoom = Math.min(
      open.width / width / (fill[0] * spanX * FIT_PADDING),
      open.height / height / (fill[1] * spanY * FIT_PADDING),
    );
    this.view.flyTo({
      zoom: clamp(zoom, 1, MAX_FIT_ZOOM),
      x: (area.west + area.east) / 2 / GRID_MAX,
      y: (area.south + area.north) / 2 / GRID_MAX,
    });
  }

  /** Flies to center a spot, in grid units, zooming in if the map is far out. */
  focusOn(x: number, y: number) {
    this.view.flyTo({
      zoom: Math.max(this.view.camera.zoom, FOCUS_ZOOM),
      x: x / GRID_MAX,
      y: y / GRID_MAX,
    });
  }

  setHighlight(highlight: Highlight | null) {
    this.highlight = highlight;
    this.requestDraw();
  }

  private drawHighlight(
    highlight: Highlight | null,
    toScreenX: (x: number) => number,
    toScreenY: (y: number) => number,
    zoom: number,
  ) {
    const { context } = this;
    if (!highlight) return;
    const radius = pointWidth(highlight.deaths, zoom) / 2 + HIGHLIGHT_GAP;
    context.beginPath();
    context.arc(toScreenX(highlight.x / GRID_MAX), toScreenY(highlight.y / GRID_MAX), radius, 0, Math.PI * 2);
    context.lineWidth = 4;
    context.strokeStyle = HIGHLIGHT_HALO;
    context.stroke();
    context.lineWidth = 1.5;
    context.strokeStyle = HIGHLIGHT_RING;
    context.stroke();
  }

  /**
   * Countries first, then places, then provinces, each most important first, skipping
   * any label that would overlap one already placed.
   */
  private drawLabels(toScreenX: (x: number) => number, toScreenY: (y: number) => number, zoom: number) {
    const placed: ScreenBox[] = [];
    const { context } = this;
    context.lineJoin = "round";
    context.lineWidth = 3;
    context.strokeStyle = LABEL_HALO;
    context.textBaseline = "middle";
    if (this.showLabels) this.drawKind(this.countries, COUNTRY_STYLE, false, placed, toScreenX, toScreenY, zoom);
    if (this.showPlaces) this.drawKind(this.places, PLACE_STYLE, true, placed, toScreenX, toScreenY, zoom);
    if (this.showLabels) this.drawKind(this.provinces, PROVINCE_STYLE, false, placed, toScreenX, toScreenY, zoom);
    context.letterSpacing = "0px";
  }

  private drawKind(
    labels: MeasuredLabel[],
    style: LabelStyle,
    hasRing: boolean,
    placed: ScreenBox[],
    toScreenX: (x: number) => number,
    toScreenY: (y: number) => number,
    zoom: number,
  ) {
    const { context, width, height } = this;
    this.applyStyle(style);
    context.textAlign = hasRing ? "left" : "center";
    for (const { label, lines, width: textWidth } of labels) {
      // Labels come sorted by the zoom they show at, so the rest show later still.
      if (label.minZoom > zoom) break;
      const x = toScreenX(label.x / GRID_MAX);
      const y = toScreenY(label.y / GRID_MAX);
      const textHeight = lines.length * style.lineHeight;
      const textLeft = hasRing ? x + PLACE_NAME_OFFSET : x - textWidth / 2;
      const box = {
        left: (hasRing ? x - PLACE_RING_RADIUS : textLeft) - LABEL_GAP,
        right: textLeft + textWidth + LABEL_GAP,
        top: y - textHeight / 2 - LABEL_GAP,
        bottom: y + textHeight / 2 + LABEL_GAP,
      };
      if (box.right < 0 || box.left > width || box.bottom < 0 || box.top > height) continue;
      if (overlapsAny(box, placed)) continue;
      placed.push(box);
      if (hasRing) {
        context.beginPath();
        context.arc(x, y, PLACE_RING_RADIUS, 0, Math.PI * 2);
        context.strokeStyle = LABEL_HALO;
        context.stroke();
        context.lineWidth = 1.25;
        context.strokeStyle = PLACE_RING_COLOR;
        context.stroke();
        context.lineWidth = 3;
        context.strokeStyle = LABEL_HALO;
      }
      context.fillStyle = style.color;
      const textX = hasRing ? textLeft : x;
      lines.forEach((line, index) => {
        const lineY = y - textHeight / 2 + (index + 0.5) * style.lineHeight;
        context.strokeText(line, textX, lineY);
        context.fillText(line, textX, lineY);
      });
    }
  }

  /** The area under a box drawn on the map. */
  boxToArea({ left, right, top, bottom }: Box): Area {
    const toGrid = (share: number) => Math.round(clamp(share, 0, 1) * GRID_MAX);
    return {
      west: toGrid(this.view.dataX(left)),
      east: toGrid(this.view.dataX(right)),
      south: toGrid(this.view.dataY(bottom)),
      north: toGrid(this.view.dataY(top)),
    };
  }

  private requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw() {
    const { context, canvas, pixelRatio, width, height, fill, area } = this;
    const { camera } = this.view;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const [centerX, centerY] = this.center;
    const toScreenX = (x: number) => width * centerX + (x - camera.x) * width * fill[0] * camera.zoom;
    const toScreenY = (y: number) => height * centerY - (y - camera.y) * height * fill[1] * camera.zoom;
    const webZoom = Math.log2((width * fill[0] * camera.zoom) / WEB_TILE_PIXELS);
    const labelZoom = Math.min(webZoom + LABEL_ZOOM_BIAS, HOME_LABEL_ZOOM + Math.log2(camera.zoom));
    this.drawLabels(toScreenX, toScreenY, labelZoom);
    this.drawHighlight(this.highlight, toScreenX, toScreenY, camera.zoom);
    this.drawHighlight(this.hovered, toScreenX, toScreenY, camera.zoom);
    if (area === WHOLE_WORLD) return;

    const left = toScreenX(area.west / GRID_MAX);
    const right = toScreenX(area.east / GRID_MAX);
    const top = toScreenY(area.north / GRID_MAX);
    const bottom = toScreenY(area.south / GRID_MAX);
    context.strokeStyle = BOX_LINE;
    context.lineWidth = 1;
    context.strokeRect(left, top, right - left, bottom - top);
  }
}

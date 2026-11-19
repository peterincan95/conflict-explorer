import type { Box } from "./box";
import type { Basemap, MapLabel, Meta } from "./data";
import { HOME, isHome, PanZoom } from "./panZoom";
import { MAP_MAX_ZOOM, mapFill, pointWidth, type EventRenderer } from "./renderer";
import { GRID_MAX, WHOLE_WORLD, type Area } from "./selection";

const MAX_PIXEL_RATIO = 2;
const BOX_LINE = "#e8e8e8";

// A label shows once the map is zoomed in as far as a web map at its zoom, less this
// bias, and only where it doesn't overlap a label already placed.
const LABEL_ZOOM_BIAS = 0.2;
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
const HIGHLIGHT_RING = "#fff";
const HIGHLIGHT_HALO = "rgb(0 0 0 / 70%)";
const HIGHLIGHT_GAP = 4;

/** An event to ring on the map, in grid units. */
export interface Highlight {
  x: number;
  y: number;
  deaths: number;
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
  private zoomListeners = new Set<(zoom: number) => void>();

  constructor(
    plot: HTMLElement,
    private canvas: HTMLCanvasElement,
    renderer: EventRenderer,
    private extent: Meta["extent"],
    onMovedChange: (isMoved: boolean) => void,
  ) {
    this.context = canvas.getContext("2d")!;
    this.view = new PanZoom(plot, -1, MAP_MAX_ZOOM, (camera) => {
      renderer.setCamera(camera);
      this.requestDraw();
      onMovedChange(!isHome(camera));
      this.zoomListeners.forEach((listener) => listener(camera.zoom));
    });
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
  }

  setLayout(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.fill = mapFill(this.extent, width, height);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.canvas.width = Math.max(1, Math.round(width * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(height * this.pixelRatio));
    this.view.setLayout(width, height, this.fill);
  }

  setArea(area: Area) {
    this.area = area;
    this.requestDraw();
  }

  /** Panning gives way to drawing a box. */
  setPanEnabled(isEnabled: boolean) {
    this.view.setPanEnabled(isEnabled);
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
    const { fill } = this;
    const spanX = Math.max(area.east - area.west, 1) / GRID_MAX;
    const spanY = Math.max(area.north - area.south, 1) / GRID_MAX;
    const zoom = Math.min(1 / (fill[0] * spanX * FIT_PADDING), 1 / (fill[1] * spanY * FIT_PADDING));
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

  private drawHighlight(toScreenX: (x: number) => number, toScreenY: (y: number) => number, zoom: number) {
    const { highlight, context } = this;
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

    const toScreenX = (x: number) => width / 2 + (x - camera.x) * width * fill[0] * camera.zoom;
    const toScreenY = (y: number) => height / 2 - (y - camera.y) * height * fill[1] * camera.zoom;
    const webZoom = Math.log2((width * fill[0] * camera.zoom) / WEB_TILE_PIXELS);
    this.drawLabels(toScreenX, toScreenY, webZoom + LABEL_ZOOM_BIAS);
    this.drawHighlight(toScreenX, toScreenY, camera.zoom);
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

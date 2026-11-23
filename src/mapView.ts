import type { Box } from "./box";
import type { Basemap, MapLabel, Meta } from "./data";
import { PanZoom } from "./panZoom";
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

// Key events in a conflict view: a point on the spot, and a leader line out to the
// event's name, with its description in small italics underneath.
const KEY_NAME_STYLE: LabelStyle = {
  font: '500 16px "Roboto Condensed", sans-serif',
  color: "#f2f2f2",
  letterSpacing: "0.2px",
  lineHeight: 19,
  uppercase: false,
  wrapWidth: 200,
};
const KEY_DESCRIPTION_STYLE: LabelStyle = {
  font: 'italic 400 12.5px "Roboto Condensed", sans-serif',
  color: "#c4c4c4",
  letterSpacing: "0px",
  lineHeight: 15,
  uppercase: false,
  wrapWidth: 200,
};
const KEY_POINT_RADIUS = 3.5;
// Leader lines rise one of these heights from the point, then run across to the text.
const KEY_LEADER_RISES = [44, 84, 124];
// Leader lines run one of these lengths across.
const KEY_LEADER_RUNS = [72, 132];
const KEY_TEXT_GAP = 8;
// Points closer than this many CSS pixels share one leader, with their texts stacked.
const KEY_MERGE_DISTANCE = 14;
const KEY_DESCRIPTION_GAP = 2;
const KEY_EVENT_SPACING = 8;
const KEY_LINE = "rgb(255 255 255 / 92%)";
const KEY_HALO = "rgb(0 0 0 / 55%)";
// How much each problem counts against a placement; the lowest total wins.
const KEY_OFF_SCREEN = 1000;
const KEY_CROSSING = 100;
const KEY_COVERS_POINT = 30;
const KEY_COVERS_LABEL = 5;

/** A key event to mark on the map, in grid units. */
export interface MapKeyEvent {
  name: string;
  description: string;
  x: number;
  y: number;
}

/** A key event ready to draw: its name and description split into lines. */
interface MeasuredKeyEvent {
  event: MapKeyEvent;
  name: string[];
  description: string[];
  /** The widest line, of the name alone and with the description. */
  nameWidth: number;
  width: number;
}

/** A thin box along a line, so lines can be checked against boxes and each other. */
const lineBox = (x1: number, y1: number, x2: number, y2: number): ScreenBox => ({
  left: Math.min(x1, x2) - 1,
  right: Math.max(x1, x2) + 1,
  top: Math.min(y1, y2) - 1,
  bottom: Math.max(y1, y2) + 1,
});

const countOverlaps = (box: ScreenBox, others: ScreenBox[]) =>
  others.filter(
    (other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top,
  ).length;

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
  /** How many of the map's widths the world spans, for web map zooms. */
  private worldScale = 1;
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
  private keyEventSource: MapKeyEvent[] = [];
  private keyEvents: MeasuredKeyEvent[] = [];
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
    private meta: Pick<Meta, "extent" | "region">,
    onMovedChange: (isMoved: boolean) => void,
  ) {
    this.context = canvas.getContext("2d")!;
    this.view = new PanZoom(plot, -1, MAP_MAX_ZOOM, (camera) => {
      renderer.setCamera(camera);
      this.requestDraw();
      onMovedChange(!this.view.isHome);
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
    return Math.log2((this.width * this.fill[0] * this.view.camera.zoom * this.worldScale) / WEB_TILE_PIXELS);
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

  /** Marks key events, with leader lines to their names and descriptions. */
  setKeyEvents(events: MapKeyEvent[]) {
    this.keyEventSource = events;
    this.measureKeyEvents();
    this.requestDraw();
  }

  private measureKeyEvents() {
    const events = this.keyEventSource;
    const asLabels = (text: (event: MapKeyEvent) => string) =>
      events.map((event) => ({ name: text(event), x: 0, y: 0, minZoom: 0 }));
    const names = this.measure(asLabels(({ name }) => name), KEY_NAME_STYLE);
    const descriptions = this.measure(asLabels(({ description }) => description), KEY_DESCRIPTION_STYLE);
    this.keyEvents = events.map((event, index) => {
      const description = event.description ? descriptions[index]! : { lines: [], width: 0 };
      return {
        event,
        name: names[index]!.lines,
        description: description.lines,
        nameWidth: names[index]!.width,
        width: Math.max(names[index]!.width, description.width),
      };
    });
  }

  private measureLabels() {
    const { basemap } = this;
    this.measureKeyEvents();
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
    const { fill, center, home, centerBounds, worldScale } = mapLayout(
      this.meta,
      this.width,
      this.height,
      this.openFrame,
    );
    this.fill = fill;
    this.center = center;
    this.worldScale = worldScale;
    this.view.setLayout(this.width, this.height, fill, center, home, centerBounds);
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
      this.view.flyHome();
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
  private drawLabels(
    toScreenX: (x: number) => number,
    toScreenY: (y: number) => number,
    zoom: number,
    placed: ScreenBox[],
  ) {
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

  /**
   * Marks each key event with a point and a leader line out to its name and description.
   * Each placement tries the side away from the other events first, then the others,
   * at a few heights, and takes the first with no problems, else the one with fewest:
   * off screen, lines crossing, text over another point or label. The texts and lines go
   * into `placed`, so map labels keep clear of them.
   */
  private drawKeyEvents(toScreenX: (x: number) => number, toScreenY: (y: number) => number, placed: ScreenBox[]) {
    const { context } = this;
    if (this.keyEvents.length === 0) return;
    const open = this.openArea;

    // Events on almost the same spot share a point and a leader, with their texts stacked.
    const groups: { x: number; y: number; members: MeasuredKeyEvent[] }[] = [];
    for (const member of this.keyEvents) {
      const x = toScreenX(member.event.x / GRID_MAX);
      const y = toScreenY(member.event.y / GRID_MAX);
      const near = groups.find((group) => Math.hypot(group.x - x, group.y - y) < KEY_MERGE_DISTANCE);
      if (!near) {
        groups.push({ x, y, members: [member] });
        continue;
      }
      near.x = (near.x * near.members.length + x) / (near.members.length + 1);
      near.y = (near.y * near.members.length + y) / (near.members.length + 1);
      near.members.push(member);
    }
    const shown = groups.filter(
      ({ x, y }) => x >= open.left && x <= open.left + open.width && y >= open.top && y <= open.top + open.height,
    );
    if (shown.length === 0) return;
    const middleX = shown.reduce((sum, group) => sum + group.x, 0) / shown.length;
    const middleY = shown.reduce((sum, group) => sum + group.y, 0) / shown.length;
    const points = shown.map(({ x, y }) => ({
      left: x - KEY_POINT_RADIUS - 2,
      right: x + KEY_POINT_RADIUS + 2,
      top: y - KEY_POINT_RADIUS - 2,
      bottom: y + KEY_POINT_RADIUS + 2,
    }));
    const texts: ScreenBox[] = [];
    const leaders: ScreenBox[] = [];
    // Groups nearest the middle go first, as they have the least room.
    const order = shown
      .map((group, index) => ({ group, index }))
      .sort(
        (a, b) =>
          Math.hypot(a.group.x - middleX, a.group.y - middleY) - Math.hypot(b.group.x - middleX, b.group.y - middleY),
      );

    for (const { group, index } of order) {
      const { x, y, members } = group;
      const otherPoints = points.filter((_, pointIndex) => pointIndex !== index);
      const across = shown.length > 1 && x < middleX ? -1 : 1;
      const down = shown.length > 1 && y > middleY + KEY_LEADER_RISES[0]! ? 1 : -1;
      const sides = [
        [across, down],
        [-across, down],
        [across, -down],
        [-across, -down],
      ] as const;

      /** The best placement for the text, with or without the descriptions. */
      const place = (withDescriptions: boolean) => {
        // Each line's offset from the top of the text, and its style.
        const lines: { text: string; top: number; style: LabelStyle }[] = [];
        let textHeight = 0;
        members.forEach((member, memberIndex) => {
          if (memberIndex > 0) textHeight += KEY_EVENT_SPACING;
          for (const text of member.name) {
            lines.push({ text, top: textHeight, style: KEY_NAME_STYLE });
            textHeight += KEY_NAME_STYLE.lineHeight;
          }
          if (!withDescriptions || member.description.length === 0) return;
          textHeight += KEY_DESCRIPTION_GAP;
          for (const text of member.description) {
            lines.push({ text, top: textHeight, style: KEY_DESCRIPTION_STYLE });
            textHeight += KEY_DESCRIPTION_STYLE.lineHeight;
          }
        });
        const textWidth = Math.max(...members.map((member) => (withDescriptions ? member.width : member.nameWidth)));
        // The name's first line sits level with the leader's end, the rest below it, unless
        // the text is too tall to fit that way, when it can sit centered on the end or above it.
        const anchors = [KEY_NAME_STYLE.lineHeight / 2, textHeight / 2, textHeight - KEY_NAME_STYLE.lineHeight / 2];
        let best: {
          score: number;
          turnY: number;
          endX: number;
          textLeft: number;
          textTop: number;
          down: number;
          text: ScreenBox;
          leaders: ScreenBox[];
        } | null = null;
        for (const [sideAcross, sideDown] of sides) {
          for (const anchor of anchors) {
            for (const run of KEY_LEADER_RUNS) {
              for (const rise of KEY_LEADER_RISES) {
                const turnY = y + sideDown * rise;
                const endX = x + sideAcross * run;
                const textLeft = sideAcross > 0 ? endX + KEY_TEXT_GAP : endX - KEY_TEXT_GAP - textWidth;
                const textTop = turnY - anchor;
                const text = {
                  left: textLeft - LABEL_GAP,
                  right: textLeft + textWidth + LABEL_GAP,
                  top: textTop - LABEL_GAP,
                  bottom: textTop + textHeight + LABEL_GAP,
                };
                const lineBoxes = [lineBox(x, y + sideDown * KEY_POINT_RADIUS, x, turnY), lineBox(x, turnY, endX, turnY)];
                const isOnScreen =
                  text.left >= open.left &&
                  text.right <= open.left + open.width &&
                  text.top >= open.top &&
                  text.bottom <= open.top + open.height;
                let score = isOnScreen ? 0 : KEY_OFF_SCREEN;
                score += KEY_CROSSING * countOverlaps(text, [...texts, ...leaders]);
                for (const box of lineBoxes) score += KEY_CROSSING * countOverlaps(box, [...texts, ...leaders]);
                for (const box of [text, ...lineBoxes]) score += KEY_COVERS_POINT * countOverlaps(box, otherPoints);
                score += KEY_COVERS_LABEL * countOverlaps(text, placed);
                if (!best || score < best.score) {
                  best = { score, turnY, endX, textLeft, textTop, down: sideDown, text, leaders: lineBoxes };
                }
                if (score === 0) return { ...best, lines };
              }
            }
          }
        }
        return { ...best!, lines };
      };
      // Text that can't be placed cleanly, as in a crowded month or a small window, leaves
      // out the descriptions if that helps.
      let layout = place(true);
      if (layout.score > 0) {
        const namesOnly = place(false);
        if (namesOnly.score < layout.score) layout = namesOnly;
      }
      const { lines } = layout;
      texts.push(layout.text);
      leaders.push(...layout.leaders);
      placed.push(layout.text, ...layout.leaders);

      const path = new Path2D();
      path.moveTo(x, y + layout.down * KEY_POINT_RADIUS);
      path.lineTo(x, layout.turnY);
      path.lineTo(layout.endX, layout.turnY);
      context.lineJoin = "round";
      context.lineWidth = 4;
      context.strokeStyle = KEY_HALO;
      context.stroke(path);
      context.lineWidth = 1.5;
      context.strokeStyle = KEY_LINE;
      context.stroke(path);

      context.beginPath();
      context.arc(x, y, KEY_POINT_RADIUS, 0, Math.PI * 2);
      context.lineWidth = 3;
      context.strokeStyle = KEY_HALO;
      context.stroke();
      context.fillStyle = KEY_LINE;
      context.fill();

      context.textAlign = "left";
      context.textBaseline = "middle";
      context.lineWidth = 3;
      context.strokeStyle = LABEL_HALO;
      for (const { text, top, style } of lines) {
        this.applyStyle(style);
        context.fillStyle = style.color;
        const lineY = layout.textTop + top + style.lineHeight / 2;
        context.strokeText(text, layout.textLeft, lineY);
        context.fillText(text, layout.textLeft, lineY);
      }
    }
    context.letterSpacing = "0px";
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
    const webZoom = this.webZoom;
    const labelZoom = Math.min(webZoom + LABEL_ZOOM_BIAS, HOME_LABEL_ZOOM + Math.log2(camera.zoom));
    const placed: ScreenBox[] = [];
    this.drawKeyEvents(toScreenX, toScreenY, placed);
    this.drawLabels(toScreenX, toScreenY, labelZoom, placed);
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

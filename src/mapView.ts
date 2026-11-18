import type { Box } from "./box";
import type { Meta } from "./data";
import { isHome, PanZoom } from "./panZoom";
import { MAP_MAX_ZOOM, mapFill, type EventRenderer } from "./renderer";
import { GRID_MAX, WHOLE_WORLD, type Area } from "./selection";

const MAX_PIXEL_RATIO = 2;
const BOX_LINE = "#e8e8e8";

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
    });
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
    if (area === WHOLE_WORLD) return;

    const toScreenX = (x: number) => width / 2 + (x - camera.x) * width * fill[0] * camera.zoom;
    const toScreenY = (y: number) => height / 2 - (y - camera.y) * height * fill[1] * camera.zoom;
    const left = toScreenX(area.west / GRID_MAX);
    const right = toScreenX(area.east / GRID_MAX);
    const top = toScreenY(area.north / GRID_MAX);
    const bottom = toScreenY(area.south / GRID_MAX);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.strokeStyle = BOX_LINE;
    context.lineWidth = 1;
    context.strokeRect(left, top, right - left, bottom - top);
  }
}

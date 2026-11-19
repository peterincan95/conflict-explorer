import type { EventData } from "./data";
import { pointWidth } from "./renderer";
import { GRID_MAX, type DayWindow } from "./selection";

// The grid's cells for finding events near a spot: this many across and down.
const CELLS = 512;
const CELL_SIZE = (GRID_MAX + 1) / CELLS;
// Points this narrow or less still catch the pointer this far from their center,
// in CSS pixels, and every point catches it this much past its edge.
const MIN_HIT_RADIUS = 4;
const HIT_SLOP = 2;

/**
 * Finds the events drawn under a spot on the map: the ones that pass the filters and
 * fall in the dates, whose point covers the spot.
 */
export class EventPicker {
  /** Event indices grouped by cell, and where each cell's group starts. */
  private order: Uint32Array;
  private cellStarts: Uint32Array;
  private visible: Uint8Array;
  private window: DayWindow = { from: 0, to: 0 };
  /** The most deaths in any event, which makes the widest point. */
  private maxDeaths = 0;

  constructor(readonly data: EventData) {
    const { x, y, best } = data;
    const count = data.meta.count;
    const cellOf = new Uint32Array(count);
    const counts = new Uint32Array(CELLS * CELLS + 1);
    for (let index = 0; index < count; index += 1) {
      const cell = Math.floor(y[index]! / CELL_SIZE) * CELLS + Math.floor(x[index]! / CELL_SIZE);
      cellOf[index] = cell;
      counts[cell + 1]! += 1;
      this.maxDeaths = Math.max(this.maxDeaths, best[index]!);
    }
    for (let cell = 0; cell < CELLS * CELLS; cell += 1) counts[cell + 1]! += counts[cell]!;
    this.cellStarts = counts.slice();
    const next = counts;
    this.order = new Uint32Array(count);
    for (let index = 0; index < count; index += 1) this.order[next[cellOf[index]!]!++] = index;
    this.visible = new Uint8Array(count);
  }

  setVisible(visible: Uint8Array) {
    this.visible = visible;
  }

  setWindow(window: DayWindow) {
    this.window = window;
  }

  /**
   * Events whose points cover a spot, deadliest first, then earliest. `x` and `y` are
   * in grid units, `scaleX` and `scaleY` are CSS pixels per grid unit across and down,
   * which differ since the grid stretches the map to a square, and `zoom` sets the
   * points' sizes.
   */
  at(x: number, y: number, scaleX: number, scaleY: number, zoom: number): number[] {
    const { data, visible, order, cellStarts } = this;
    const { from, to } = this.window;
    const reach = Math.max(pointWidth(this.maxDeaths, zoom), MIN_HIT_RADIUS * 2) / 2 + HIT_SLOP;
    const cellRange = (low: number, high: number) =>
      [Math.max(0, Math.floor(low / CELL_SIZE)), Math.min(CELLS - 1, Math.floor(high / CELL_SIZE))] as const;
    const [firstColumn, lastColumn] = cellRange(x - reach / scaleX, x + reach / scaleX);
    const [firstRow, lastRow] = cellRange(y - reach / scaleY, y + reach / scaleY);
    const hits: number[] = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const cell = row * CELLS + column;
        for (let at = cellStarts[cell]!; at < cellStarts[cell + 1]!; at += 1) {
          const index = order[at]!;
          if (!visible[index] || data.start[index]! >= to || data.end[index]! < from) continue;
          const radius = Math.max(pointWidth(data.best[index]!, zoom) / 2, MIN_HIT_RADIUS) + HIT_SLOP;
          const distance = Math.hypot((data.x[index]! - x) * scaleX, (data.y[index]! - y) * scaleY);
          if (distance <= radius) hits.push(index);
        }
      }
    }
    // Events come sorted by day, so index order breaks ties by date.
    return hits.sort((a, b) => data.best[b]! - data.best[a]! || a - b);
  }
}

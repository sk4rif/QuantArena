import type { Replica } from "../game/replica";
import type { FoodWire } from "../net/protocol";
import { dequantizePosition } from "../net/protocol";

const GRID_SIZE = 64;
/** Deeper than the heatmap's red peak (hue 4), so a snake stays readable on top of dense money. */
const SNAKE_MARKER_COLOR = "#b92405";
const SPAWN_MARKER_COLOR = "#f472b6";
/** Light map surface, matching the cream arena. See the palette in `site.css`. */
const MAP_BACKGROUND = "#f4f0ed";
const MAP_EDGE_COLOR = "rgba(219, 82, 55, 0.5)";
/** The local snake is picked out with a dark halo, which reads on a light map where white did not. */
const LOCAL_HALO_COLOR = "rgba(46, 28, 22, 0.85)";
const LOCAL_OUTLINE_COLOR = "#2e1c16";

/** Money density is drawn on a green scale: pale green is sparse, deep green is dense. */
const HEAT_LOW: [number, number, number] = [147, 217, 163];
const HEAT_HIGH: [number, number, number] = [20, 106, 51];

function heatCell(intensity: number): string {
  const channel = (index: 0 | 1 | 2) => Math.round(HEAT_LOW[index] + (HEAT_HIGH[index] - HEAT_LOW[index]) * intensity);
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${0.2 + intensity * 0.8})`;
}
// Must match SPAWN_GRID and SPAWN_WEIGHT_EPSILON in src/game/placement.rs.
const SPAWN_GRID = 64;
const SPAWN_WEIGHT_EPSILON = 100;

export interface MoneyGrid {
  cells: Float64Array;
  maximum: number;
  total: number;
  size: number;
}

export function buildMoneyGrid(food: Iterable<FoodWire>, halfExtent: number, size = GRID_SIZE): MoneyGrid {
  const cells = new Float64Array(size * size);
  let maximum = 0;
  let total = 0;
  for (const item of food) {
    const x = dequantizePosition(item.x);
    const y = dequantizePosition(item.y);
    const column = Math.floor(((x + halfExtent) / (halfExtent * 2)) * size);
    const row = Math.floor(((y + halfExtent) / (halfExtent * 2)) * size);
    if (column < 0 || column >= size || row < 0 || row >= size) continue;
    const index = row * size + column;
    const value = (cells[index] ?? 0) + item.valueNanos;
    cells[index] = value;
    maximum = Math.max(maximum, value);
    total += item.valueNanos;
  }
  return { cells, maximum, total, size };
}

export interface Point {
  x: number;
  y: number;
}

interface Stake {
  x: number;
  y: number;
  worthNanos: number;
}

/** AUM weight of the map at (x, y): every snake adds AUM_p / (distance^2 + epsilon). Mirrors the server. */
export function aumWeightAt(x: number, y: number, stakes: readonly Stake[], halfExtent: number): number {
  const size = halfExtent * 2;
  let weight = 0;
  for (const stake of stakes) {
    const rawDx = Math.abs(x - dequantizePosition(stake.x));
    const rawDy = Math.abs(y - dequantizePosition(stake.y));
    const dx = Math.min(rawDx, size - rawDx);
    const dy = Math.min(rawDy, size - rawDy);
    weight += stake.worthNanos / (dx * dx + dy * dy + SPAWN_WEIGHT_EPSILON);
  }
  return weight;
}

/**
 * The lowest-AUM-weight point of the arena, found by scanning a fixed grid row by row (first cell wins ties).
 * Same rule as the server's `spawn_point`; `halfExtent` is in world units, not quantized.
 */
export function spawnPoint(stakes: Iterable<Stake>, halfExtent: number): Point | undefined {
  const list = [...stakes];
  if (list.every((stake) => stake.worthNanos <= 0)) return undefined;
  const cell = (halfExtent * 2) / SPAWN_GRID;
  let best: (Point & { weight: number }) | undefined;
  for (let row = 0; row < SPAWN_GRID; row += 1) {
    for (let column = 0; column < SPAWN_GRID; column += 1) {
      const x = -halfExtent + (column + 0.5) * cell;
      const y = -halfExtent + (row + 0.5) * cell;
      const weight = aumWeightAt(x, y, list, halfExtent);
      if (!best || weight < best.weight) best = { x, y, weight };
    }
  }
  return best && { x: best.x, y: best.y };
}

export function economicHeatIntensity(valueNanos: number, maximumNanos: number): number {
  if (valueNanos <= 0 || maximumNanos <= 0) return 0;
  return Math.sqrt(Math.min(1, valueNanos / maximumNanos));
}

export class Minimap {
  private readonly context: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly replica: Replica,
  ) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Minimap Canvas 2D is unavailable");
    this.context = context;
    window.addEventListener("resize", this.render);
    this.render();
  }

  readonly render = (): void => {
    const bounds = this.canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * ratio));
    const height = Math.max(1, Math.round(bounds.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const context = this.context;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    const size = Math.min(bounds.width, bounds.height) - 8;
    const left = (bounds.width - size) / 2;
    const top = (bounds.height - size) / 2;
    context.save();
    context.beginPath();
    context.rect(left, top, size, size);
    context.clip();
    context.fillStyle = MAP_BACKGROUND;
    context.fillRect(left, top, size, size);

    const halfExtent = dequantizePosition(this.replica.arenaHalfExtent);
    const grid = buildMoneyGrid(this.replica.food.values(), halfExtent);
    this.drawHeatmap(context, grid, left, top, size);
    this.drawSnakes(context, left, top, size, halfExtent);
    this.drawSpawnPoint(context, left, top, size, halfExtent);
    context.restore();

    context.strokeStyle = MAP_EDGE_COLOR;
    context.lineWidth = 1.5;
    context.strokeRect(left, top, size, size);
  };

  private drawHeatmap(
    context: CanvasRenderingContext2D,
    grid: MoneyGrid,
    left: number,
    top: number,
    diameter: number,
  ): void {
    if (grid.maximum <= 0) return;
    const cellSize = diameter / grid.size;
    for (let row = 0; row < grid.size; row += 1) {
      for (let column = 0; column < grid.size; column += 1) {
        const value = grid.cells[row * grid.size + column] ?? 0;
        if (value <= 0) continue;
        const intensity = economicHeatIntensity(value, grid.maximum);
        context.fillStyle = heatCell(intensity);
        context.fillRect(left + column * cellSize, top + row * cellSize, cellSize + 0.5, cellSize + 0.5);
      }
    }
  }

  private drawSpawnPoint(
    context: CanvasRenderingContext2D,
    left: number,
    top: number,
    size: number,
    halfExtent: number,
  ): void {
    const spawn = spawnPoint(this.replica.snakes.values(), halfExtent);
    if (!spawn) return;
    const x = left + ((spawn.x + halfExtent) / (halfExtent * 2)) * size;
    const y = top + ((spawn.y + halfExtent) / (halfExtent * 2)) * size;
    context.strokeStyle = SPAWN_MARKER_COLOR;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(x, y, 6, 0, Math.PI * 2);
    context.moveTo(x - 10, y);
    context.lineTo(x + 10, y);
    context.moveTo(x, y - 10);
    context.lineTo(x, y + 10);
    context.stroke();
  }

  private drawSnakes(
    context: CanvasRenderingContext2D,
    left: number,
    top: number,
    size: number,
    halfExtent: number,
  ): void {
    const ticket = this.replica.economyConfig?.ticketNanos ?? 1;
    const project = (value: number, offset: number) => offset + ((dequantizePosition(value) + halfExtent) / (halfExtent * 2)) * size;
    for (const snake of this.replica.snakes.values()) {
      const x = project(snake.x, left);
      const y = project(snake.y, top);
      const markerRadius = Math.max(2.2, Math.min(6, 2.2 + Math.sqrt(snake.worthNanos / ticket)));
      const local = snake.id === this.replica.playerId;
      const body = snake.body.map((point) => ({
        x: project(point.x, left),
        y: project(point.y, top),
      }));
      body.push({ x, y });
      const traceBody = (): void => {
        const first = body[0];
        if (!first) return;
        context.beginPath();
        context.moveTo(first.x, first.y);
        let previous = first;
        for (const point of body.slice(1)) {
          if (Math.abs(point.x - previous.x) <= size / 2 && Math.abs(point.y - previous.y) <= size / 2) {
            context.lineTo(point.x, point.y);
          } else {
            context.moveTo(point.x, point.y);
          }
          previous = point;
        }
        context.stroke();
      };
      context.lineCap = "round";
      context.lineJoin = "round";
      if (local) {
        context.strokeStyle = LOCAL_HALO_COLOR;
        context.lineWidth = 4;
        traceBody();
      }
      context.strokeStyle = SNAKE_MARKER_COLOR;
      context.lineWidth = local ? 2.5 : 1.8;
      traceBody();
      context.fillStyle = SNAKE_MARKER_COLOR;
      context.beginPath();
      context.arc(x, y, markerRadius, 0, Math.PI * 2);
      context.fill();
      if (local) {
        context.strokeStyle = LOCAL_OUTLINE_COLOR;
        context.lineWidth = 1.5;
        context.stroke();
      }
    }
  }
}

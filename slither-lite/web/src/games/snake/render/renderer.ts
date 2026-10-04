import { nearestWrappedCoordinate } from "../game/geometry";
import type { InputState } from "../game/input";
import { LocalPrediction } from "../game/prediction";
import type { Replica } from "../game/replica";
import { dequantizeAngle, dequantizePosition, formatMoney } from "../net/protocol";
import type { GameAssets } from "./assets";
import { Camera } from "./camera";

/** Arena surface colours. Kept in step with the site palette in `site.css` by hand, since the canvas cannot read custom properties per frame. */
const ARENA_BACKGROUND = "#fbfaf8";
/** rgb(219, 82, 55) at low opacity, so the grid reads as graph paper rather than as content. */
const ARENA_GRID = "rgba(219, 82, 55, 0.2)";
/** Labels sit partly on the cream background, so they have to be dark rather than white. */
const LABEL_COLOR = "#2e1c16";
const PICKUP_EFFECT_DURATION = 900;

interface PickupEffect {
  valueNanos: number;
  startedAt: number;
}

const skinColors: Record<string, string> = {
  red: "#ef5350",
  blue: "#42a5f5",
  green: "#66bb6a",
  purple: "#ab47bc",
  orange: "#ffa726",
  yellow: "#ffee58",
};

export class Renderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly camera = new Camera();
  private readonly prediction = new LocalPrediction();
  private lastFrame = performance.now();
  private frame = 0;
  private pickupEffects: PickupEffect[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly replica: Replica,
    private readonly input: InputState,
    private readonly assets: GameAssets,
  ) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.context = context;
    window.addEventListener("resize", this.resize);
    this.resize();
  }

  start(): void {
    this.frame = requestAnimationFrame(this.render);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener("resize", this.resize);
  }

  reconcile(): void {
    this.prediction.reconcile(this.replica);
  }

  showPickup(valueNanos: number): void {
    this.pickupEffects.push({ valueNanos, startedAt: performance.now() });
  }

  private readonly resize = (): void => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(innerWidth * ratio);
    this.canvas.height = Math.round(innerHeight * ratio);
    this.canvas.style.width = `${innerWidth}px`;
    this.canvas.style.height = `${innerHeight}px`;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  private readonly render = (now: number): void => {
    const deltaSeconds = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    this.prediction.update(this.replica, this.input, deltaSeconds);
    const local = this.replica.snakes.get(this.replica.playerId);
    if (local && this.prediction.initialized) {
      this.camera.follow(this.prediction.x, this.prediction.y, dequantizePosition(local.radius));
    }
    this.draw(now);
    this.frame = requestAnimationFrame(this.render);
  };

  private draw(now: number): void {
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = ARENA_BACKGROUND;
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    context.setTransform(
      ratio * this.camera.zoom,
      0,
      0,
      ratio * this.camera.zoom,
      this.canvas.width / 2 - this.camera.x * ratio * this.camera.zoom,
      this.canvas.height / 2 - this.camera.y * ratio * this.camera.zoom,
    );
    this.drawGrid(context);
    this.drawFood(context);
    this.drawSnakes(context);
    this.drawPickupEffects(context, now);
  }

  private drawGrid(context: CanvasRenderingContext2D): void {
    const width = innerWidth / this.camera.zoom;
    const height = innerHeight / this.camera.zoom;
    const startX = Math.floor((this.camera.x - width / 2) / 80) * 80;
    const endX = this.camera.x + width / 2;
    const startY = Math.floor((this.camera.y - height / 2) / 80) * 80;
    const endY = this.camera.y + height / 2;
    context.strokeStyle = ARENA_GRID;
    context.lineWidth = 1 / this.camera.zoom;
    context.beginPath();
    for (let x = startX; x <= endX; x += 80) {
      context.moveTo(x, startY);
      context.lineTo(x, endY);
    }
    for (let y = startY; y <= endY; y += 80) {
      context.moveTo(startX, y);
      context.lineTo(endX, y);
    }
    context.stroke();
  }

  private drawFood(context: CanvasRenderingContext2D): void {
    const halfExtent = dequantizePosition(this.replica.arenaHalfExtent);
    for (const item of this.replica.food.values()) {
      const x = nearestWrappedCoordinate(dequantizePosition(item.x), this.camera.x, halfExtent);
      const y = nearestWrappedCoordinate(dequantizePosition(item.y), this.camera.y, halfExtent);
      const radius = dequantizePosition(item.radius);
      if (!this.visible(x, y, radius * 3)) continue;
      const glowRadius = radius * 2.8;
      const glow = context.createRadialGradient(x, y, 0, x, y, glowRadius);
      glow.addColorStop(0, "rgba(34, 197, 94, .72)");
      glow.addColorStop(.35, "rgba(34, 197, 94, .34)");
      glow.addColorStop(1, "rgba(34, 197, 94, 0)");
      context.save();
      context.fillStyle = glow;
      context.beginPath();
      context.arc(x, y, glowRadius, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#22c55e";
      context.shadowColor = "#16a34a";
      context.shadowBlur = radius * 1.8;
      context.beginPath();
      context.arc(x, y, radius * .72, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }

  private drawSnakes(context: CanvasRenderingContext2D): void {
    const snakes = [...this.replica.snakes.values()].sort((left, right) => left.id - right.id);
    const halfExtent = dequantizePosition(this.replica.arenaHalfExtent);
    for (const snake of snakes) {
      const radius = dequantizePosition(snake.radius);
      const color = skinColors[snake.skin] ?? "#ef5350";
      for (const point of snake.body) {
        const x = nearestWrappedCoordinate(dequantizePosition(point.x), this.camera.x, halfExtent);
        const y = nearestWrappedCoordinate(dequantizePosition(point.y), this.camera.y, halfExtent);
        if (!this.visible(x, y, radius)) continue;
        context.fillStyle = color;
        context.beginPath();
        context.arc(x, y, radius * 0.86, 0, Math.PI * 2);
        context.fill();
        if (snake.skin === "red") context.drawImage(this.assets.body, x - radius, y - radius, radius * 2, radius * 2);
      }
      let x = nearestWrappedCoordinate(dequantizePosition(snake.x), this.camera.x, halfExtent);
      let y = nearestWrappedCoordinate(dequantizePosition(snake.y), this.camera.y, halfExtent);
      if (snake.id === this.replica.playerId && this.prediction.initialized) {
        x = this.prediction.x;
        y = this.prediction.y;
      }
      context.save();
      context.translate(x, y);
      context.rotate(dequantizeAngle(snake.angle));
      context.drawImage(this.assets.head, -radius * 1.15, -radius * 1.15, radius * 2.3, radius * 2.3);
      context.restore();
      context.fillStyle = LABEL_COLOR;
      context.font = "600 13px system-ui";
      context.textAlign = "center";
      context.fillText(snake.name, x, y - radius - 11);
    }
  }

  private drawPickupEffects(context: CanvasRenderingContext2D, now: number): void {
    this.pickupEffects = this.pickupEffects.filter((effect) => now - effect.startedAt < PICKUP_EFFECT_DURATION);
    const halfExtent = dequantizePosition(this.replica.arenaHalfExtent);
    for (const effect of this.pickupEffects) {
      const snake = this.replica.snakes.get(this.replica.playerId);
      if (!snake) continue;
      const progress = (now - effect.startedAt) / PICKUP_EFFECT_DURATION;
      const eased = 1 - (1 - progress) ** 3;
      const radius = dequantizePosition(snake.radius);
      let x = nearestWrappedCoordinate(dequantizePosition(snake.x), this.camera.x, halfExtent);
      let y = nearestWrappedCoordinate(dequantizePosition(snake.y), this.camera.y, halfExtent);
      if (snake.id === this.replica.playerId && this.prediction.initialized) {
        x = this.prediction.x;
        y = this.prediction.y;
      }
      context.save();
      context.translate(x, y - radius - 32 - eased * 30);
      const scale = .82 + Math.min(progress * 5, 1) * .18;
      context.scale(scale, scale);
      const fadeProgress = Math.max(0, Math.min(1, (progress - .2) / .8));
      context.globalAlpha = 1 - fadeProgress * fadeProgress * (3 - 2 * fadeProgress);
      context.font = "800 16px system-ui";
      context.textAlign = "center";
      context.fillStyle = "#15803d";
      const label = `+${formatMoney(effect.valueNanos).replace(/(\.\d{2})0$/, "$1")}`;
      context.fillText(label, 0, 0);
      context.restore();
    }
  }

  private visible(x: number, y: number, margin: number): boolean {
    const halfWidth = innerWidth / this.camera.zoom / 2 + margin;
    const halfHeight = innerHeight / this.camera.zoom / 2 + margin;
    return Math.abs(x - this.camera.x) <= halfWidth && Math.abs(y - this.camera.y) <= halfHeight;
  }
}

import { gravitationalOffset, nearestWrappedCoordinate } from "../game/geometry";
import type { InputState } from "../game/input";
import { BodyInterpolation, LocalPrediction, RemoteInterpolation } from "../game/prediction";
import type { Replica } from "../game/replica";
import { FOOD_GLOW_RADIUS_MULTIPLIER, dequantizeAngle, dequantizePosition, formatMoney, type FoodWire } from "../net/protocol";
import { Camera } from "./camera";

/** Arena surface colours. Kept in step with the site palette in `site.css` by hand, since the canvas cannot read custom properties per frame. */
const ARENA_BACKGROUND = "#fbfaf8";
/** rgb(219, 82, 55) at low opacity, so the grid reads as graph paper rather than as content. */
const ARENA_GRID = "rgba(219, 82, 55, 0.2)";
/** Labels sit partly on the cream background, so they have to be dark rather than white. */
const LABEL_COLOR = "#2e1c16";
const ABSORPTION_DURATION = 360;
const PICKUP_EFFECT_DURATION = 900;
const FOOD_SPAWN_DURATION = 220;
const FOOD_LOW_COLOR = [147, 217, 163] as const;
const FOOD_HIGH_COLOR = [20, 106, 51] as const;

interface FoodRenderGroup {
  id: number;
  ids: number[];
  x: number;
  y: number;
  radius: number;
  count: number;
  valueNanos: number;
}

interface PickupEffect {
  valueNanos: number;
  groups: FoodRenderGroup[];
  startedAt: number;
}

interface BodyPalette {
  core: string;
  rim: string;
  edge: string;
}

const defaultBodyPalette: BodyPalette = { core: "#f12605", rim: "#ff5b47", edge: "#d91d0a" };

const bodyPalettes: Record<string, BodyPalette> = {
  red: defaultBodyPalette,
  blue: { core: "#1e88e5", rim: "#64b5f6", edge: "#1565c0" },
  green: { core: "#43a047", rim: "#81c784", edge: "#2e7d32" },
  purple: { core: "#8e24aa", rim: "#ce93d8", edge: "#6a1b9a" },
  orange: { core: "#fb8c00", rim: "#ffb74d", edge: "#ef6c00" },
  yellow: { core: "#fdd835", rim: "#fff176", edge: "#f9a825" },
};
const adversarySkins = ["blue", "green", "purple", "orange", "yellow"] as const;

function drawSnakeOrb(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  palette: BodyPalette,
): void {
  const gradient = context.createRadialGradient(
    x - radius * 0.16,
    y - radius * 0.2,
    radius * 0.12,
    x,
    y,
    radius,
  );
  gradient.addColorStop(0, palette.core);
  gradient.addColorStop(0.72, palette.core);
  gradient.addColorStop(0.91, palette.rim);
  gradient.addColorStop(1, palette.edge);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
}

function drawSnakeEye(context: CanvasRenderingContext2D, radius: number): void {
  context.fillStyle = "#fcfaf8";
  context.beginPath();
  context.arc(radius * 0.42, 0, radius * 0.3, 0, Math.PI * 2);
  context.fill();
}

export function adversarySkin(id: number): string {
  let hash = id >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return adversarySkins[hash % adversarySkins.length] ?? "blue";
}

export function groupFoodByPosition(items: Iterable<FoodWire>): FoodRenderGroup[] {
  const groups = new Map<string, FoodRenderGroup>();
  for (const item of items) {
    const key = `${item.x},${item.y}`;
    const group = groups.get(key);
    if (group) {
      group.ids.push(item.id);
      group.radius = Math.max(group.radius, item.radius);
      group.count += 1;
      group.valueNanos += item.valueNanos;
    } else {
      groups.set(key, {
        id: item.id,
        ids: [item.id],
        x: item.x,
        y: item.y,
        radius: item.radius,
        count: 1,
        valueNanos: item.valueNanos,
      });
    }
  }
  return [...groups.values()];
}

export function foodValueConcentration(valueNanos: number, baseValueNanos: number): number {
  return Math.min(1, Math.log2(Math.max(1, valueNanos / Math.max(1, baseValueNanos))) / 4);
}

export function foodValueColor(concentration: number): { red: number; green: number; blue: number } {
  const progress = Math.max(0, Math.min(1, concentration));
  return {
    red: Math.round(FOOD_LOW_COLOR[0] + (FOOD_HIGH_COLOR[0] - FOOD_LOW_COLOR[0]) * progress),
    green: Math.round(FOOD_LOW_COLOR[1] + (FOOD_HIGH_COLOR[1] - FOOD_LOW_COLOR[1]) * progress),
    blue: Math.round(FOOD_LOW_COLOR[2] + (FOOD_HIGH_COLOR[2] - FOOD_LOW_COLOR[2]) * progress),
  };
}

export class Renderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly camera = new Camera();
  private readonly prediction = new LocalPrediction();
  private readonly remoteInterpolation = new RemoteInterpolation();
  private readonly bodyInterpolation = new BodyInterpolation();
  private lastFrame = performance.now();
  private frame = 0;
  private pickupEffects: PickupEffect[] = [];
  private foodGroups: FoodRenderGroup[] = [];
  private readonly foodSpawnedAt = new Map<number, number>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly replica: Replica,
    private readonly input: InputState,
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

  moveCamera(x: number, y: number): void {
    this.camera.moveTo(x, y);
  }

  reconcile(): void {
    const now = performance.now();
    this.prediction.reconcile(this.replica);
    this.remoteInterpolation.reconcile(this.replica, now);
    this.bodyInterpolation.reconcile(this.replica, now);
    this.foodGroups = groupFoodByPosition(this.replica.food.values());
  }

  showFoodSpawns(items: FoodWire[]): void {
    const now = performance.now();
    for (const item of items) this.foodSpawnedAt.set(item.id, now);
  }

  showPickup(valueNanos: number, items: FoodWire[]): void {
    this.pickupEffects.push({
      valueNanos,
      groups: groupFoodByPosition(items),
      startedAt: performance.now(),
    });
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
    } else {
      this.camera.pan(this.input.panX, this.input.panY, deltaSeconds);
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
    this.drawFood(context, now);
    this.drawSnakes(context, now);
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

  private drawFood(context: CanvasRenderingContext2D, now: number): void {
    for (const [id, spawnedAt] of this.foodSpawnedAt) {
      if (now - spawnedAt >= FOOD_SPAWN_DURATION || !this.replica.food.has(id)) this.foodSpawnedAt.delete(id);
    }
    const halfExtent = dequantizePosition(this.replica.arenaHalfExtent);
    const denominations = this.replica.economyConfig?.denominationsNanos;
    const baseValueNanos = denominations && denominations.length > 0 ? Math.min(...denominations) : 1;
    const local = this.replica.snakes.get(this.replica.playerId);
    const head = local
      ? {
          x: this.prediction.initialized
            ? this.prediction.x
            : nearestWrappedCoordinate(dequantizePosition(local.x), this.camera.x, halfExtent),
          y: this.prediction.initialized
            ? this.prediction.y
            : nearestWrappedCoordinate(dequantizePosition(local.y), this.camera.y, halfExtent),
          radius: dequantizePosition(local.radius),
        }
      : undefined;
    for (const group of this.foodGroups) {
      const x = nearestWrappedCoordinate(dequantizePosition(group.x), this.camera.x, halfExtent);
      const y = nearestWrappedCoordinate(dequantizePosition(group.y), this.camera.y, halfExtent);
      const radius = dequantizePosition(group.radius);
      if (!this.visible(x, y, radius * 3)) continue;
      let spawnedAt: number | undefined;
      let established = false;
      for (const id of group.ids) {
        const itemSpawnedAt = this.foodSpawnedAt.get(id);
        if (itemSpawnedAt === undefined) established = true;
        else spawnedAt = Math.max(spawnedAt ?? itemSpawnedAt, itemSpawnedAt);
      }
      const progress = spawnedAt === undefined
        ? 1
        : Math.max(0, Math.min(1, (now - spawnedAt) / FOOD_SPAWN_DURATION));
      if (!established && progress === 0) continue;
      const entrance = established ? 1 : 1 - (1 - progress) ** 3;
      const pulse = spawnedAt === undefined ? 1 : 1 + Math.sin(Math.PI * progress) * .18;
      const scale = entrance * pulse;
      const coreOffset = head
        ? gravitationalOffset(
            nearestWrappedCoordinate(head.x, x, halfExtent) - x,
            nearestWrappedCoordinate(head.y, y, halfExtent) - y,
            radius * FOOD_GLOW_RADIUS_MULTIPLIER,
            radius * .72,
            head.radius,
          )
        : { x: 0, y: 0 };
      this.drawMoneyDot(
        context,
        x,
        y,
        radius * scale,
        entrance,
        coreOffset.x * scale,
        coreOffset.y * scale,
        foodValueConcentration(group.valueNanos, baseValueNanos),
      );
    }
  }

  private drawSnakes(context: CanvasRenderingContext2D, now: number): void {
    const snakes = [...this.replica.snakes.values()].sort((left, right) => left.id - right.id);
    const halfExtent = dequantizePosition(this.replica.arenaHalfExtent);
    for (const snake of snakes) {
      const radius = dequantizePosition(snake.radius);
      const skin = snake.id === this.replica.playerId ? snake.skin : adversarySkin(snake.id);
      const palette = bodyPalettes[skin] ?? defaultBodyPalette;
      const segmentRadius = radius;
      const remotePose = this.remoteInterpolation.pose(snake.id, now);
      let x = nearestWrappedCoordinate(remotePose?.x ?? dequantizePosition(snake.x), this.camera.x, halfExtent);
      let y = nearestWrappedCoordinate(remotePose?.y ?? dequantizePosition(snake.y), this.camera.y, halfExtent);
      let angle = remotePose?.angle ?? dequantizeAngle(snake.angle);
      if (snake.id === this.replica.playerId && this.prediction.initialized) {
        x = this.prediction.x;
        y = this.prediction.y;
        angle = dequantizeAngle(snake.angle);
      }
      const body = this.bodyInterpolation.trail(snake.id, { x, y }, halfExtent, now)
        ?? snake.body.map((point) => ({ x: dequantizePosition(point.x), y: dequantizePosition(point.y) }));
      for (const point of body) {
        const bodyX = nearestWrappedCoordinate(point.x, this.camera.x, halfExtent);
        const bodyY = nearestWrappedCoordinate(point.y, this.camera.y, halfExtent);
        if (!this.visible(bodyX, bodyY, radius)) continue;
        drawSnakeOrb(context, bodyX, bodyY, segmentRadius, palette);
      }
      drawSnakeOrb(context, x, y, segmentRadius, palette);
      context.fillStyle = "rgba(46, 28, 22, 0.1)";
      context.beginPath();
      context.arc(x, y, segmentRadius, 0, Math.PI * 2);
      context.fill();
      context.save();
      context.translate(x, y);
      context.rotate(angle);
      drawSnakeEye(context, segmentRadius);
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
    const denominations = this.replica.economyConfig?.denominationsNanos;
    const baseValueNanos = denominations && denominations.length > 0 ? Math.min(...denominations) : 1;
    for (const effect of this.pickupEffects) {
      const snake = this.replica.snakes.get(this.replica.playerId);
      if (!snake) continue;
      const elapsed = now - effect.startedAt;
      const radius = dequantizePosition(snake.radius);
      let targetX = nearestWrappedCoordinate(dequantizePosition(snake.x), this.camera.x, halfExtent);
      let targetY = nearestWrappedCoordinate(dequantizePosition(snake.y), this.camera.y, halfExtent);
      if (this.prediction.initialized) {
        targetX = this.prediction.x;
        targetY = this.prediction.y;
      }
      const attractionProgress = Math.max(0, Math.min(1, elapsed / ABSORPTION_DURATION));
      const attraction = attractionProgress * attractionProgress * (3 - 2 * attractionProgress);
      for (const group of effect.groups) {
        if (attractionProgress >= 1) break;
        const sourceX = nearestWrappedCoordinate(dequantizePosition(group.x), targetX, halfExtent);
        const sourceY = nearestWrappedCoordinate(dequantizePosition(group.y), targetY, halfExtent);
        const deltaX = targetX - sourceX;
        const deltaY = targetY - sourceY;
        const distance = Math.hypot(deltaX, deltaY);
        const curve = (group.id % 2 === 0 ? 1 : -1)
          * Math.min(12, distance * .3)
          * Math.sin(Math.PI * attractionProgress);
        const x = sourceX + deltaX * attraction - (deltaY / Math.max(1, distance)) * curve;
        const y = sourceY + deltaY * attraction + (deltaX / Math.max(1, distance)) * curve;
        this.drawMoneyDot(
          context,
          x,
          y,
          dequantizePosition(group.radius) * (1 - attraction * .55),
          1 - attraction ** 3,
          0,
          0,
          foodValueConcentration(group.valueNanos, baseValueNanos),
        );
      }
      const labelDelay = ABSORPTION_DURATION * .55;
      if (elapsed < labelDelay) continue;
      const progress = Math.min(1, (elapsed - labelDelay) / (PICKUP_EFFECT_DURATION - labelDelay));
      const eased = 1 - (1 - progress) ** 3;
      context.save();
      context.translate(targetX, targetY - radius - 32 - eased * 30);
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

  private drawMoneyDot(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    alpha = 1,
    coreOffsetX = 0,
    coreOffsetY = 0,
    concentration = 0,
  ): void {
    const { red, green, blue } = foodValueColor(concentration);
    const glowRadius = radius * FOOD_GLOW_RADIUS_MULTIPLIER;
    const glow = context.createRadialGradient(x, y, 0, x, y, glowRadius);
    glow.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${.45 + concentration * .27})`);
    glow.addColorStop(.35, `rgba(${red}, ${green}, ${blue}, ${.2 + concentration * .18})`);
    glow.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = glow;
    context.beginPath();
    context.arc(x, y, glowRadius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
    context.shadowColor = `rgb(${Math.round(red * .72)}, ${Math.round(green * .72)}, ${Math.round(blue * .72)})`;
    context.shadowBlur = radius * (1.8 + concentration * .8);
    context.beginPath();
    context.arc(x + coreOffsetX, y + coreOffsetY, radius * .72, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  private visible(x: number, y: number, margin: number): boolean {
    const halfWidth = innerWidth / this.camera.zoom / 2 + margin;
    const halfHeight = innerHeight / this.camera.zoom / 2 + margin;
    return Math.abs(x - this.camera.x) <= halfWidth && Math.abs(y - this.camera.y) <= halfHeight;
  }
}

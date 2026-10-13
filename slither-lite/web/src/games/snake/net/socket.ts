import { wrappedDelta } from "../game/geometry";
import type { InputState } from "../game/input";
import { Replica } from "../game/replica";
import { FOOD_GLOW_RADIUS_MULTIPLIER, PROTOCOL_VERSION, isServerMessage, type CashOutReceiptMessage, type DeltaMessage, type EliminatedMessage, type FoodWire } from "./protocol";

export type ConnectionStatus = "connecting" | "connected" | "resyncing" | "disconnected" | "error";

/**
 * Jitter floor only (0.001°). Any real pointer motion sends on the next 30 Hz
 * sample. A wider deadzone leaves the server on the old heading.
 */
export const INPUT_AIM_EPSILON_RADIANS = (0.001 * Math.PI) / 180;
/** The server keeps the last aim and boost, so this only refreshes the session. */
export const INPUT_KEEPALIVE_MS = 400;
export const RESYNC_MIN_INTERVAL_MS = 1000;
export const DIGEST_MISMATCHES_BEFORE_RESYNC = 2;

export type ResyncReason = "sequenceGap" | "digestMismatch";

export interface SentInput {
  aim: number;
  boost: boolean;
  sentAt: number;
}

export interface ResyncStep {
  resyncing: boolean;
  send: ResyncReason | null;
}

export function aimChangedMeaningfully(previous: number, next: number): boolean {
  if (!Number.isFinite(previous) || !Number.isFinite(next)) return true;
  const delta = Math.atan2(Math.sin(next - previous), Math.cos(next - previous));
  return Math.abs(delta) >= INPUT_AIM_EPSILON_RADIANS;
}

export function shouldSendInput(input: InputState, last: SentInput | undefined, now: number): boolean {
  if (!last) return true;
  if (input.boost !== last.boost) return true;
  if (aimChangedMeaningfully(last.aim, input.aim)) return true;
  return now - last.sentAt >= INPUT_KEEPALIVE_MS;
}

/** Sequence gaps resync immediately. Digest mismatches wait for a second consecutive miss. Both are limited to one request per second. */
export class ResyncController {
  private consecutiveDigestMismatches = 0;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private queued: ResyncReason | null = null;

  reset(): void {
    this.consecutiveDigestMismatches = 0;
    this.lastSentAt = Number.NEGATIVE_INFINITY;
    this.queued = null;
  }

  synchronized(): void {
    this.consecutiveDigestMismatches = 0;
    this.queued = null;
  }

  digestMismatch(now: number): ResyncStep {
    this.consecutiveDigestMismatches += 1;
    const resyncing = this.consecutiveDigestMismatches >= DIGEST_MISMATCHES_BEFORE_RESYNC;
    if (resyncing) this.remember("digestMismatch");
    return { resyncing, send: this.poll(now) };
  }

  sequenceGap(now: number): ResyncStep {
    this.remember("sequenceGap");
    return { resyncing: true, send: this.poll(now) };
  }

  poll(now: number): ResyncReason | null {
    if (!this.queued || now - this.lastSentAt < RESYNC_MIN_INTERVAL_MS) return null;
    const reason = this.queued;
    this.queued = null;
    this.lastSentAt = now;
    if (reason === "digestMismatch") this.consecutiveDigestMismatches = 0;
    return reason;
  }

  private remember(reason: ResyncReason): void {
    if (this.queued !== "sequenceGap" || reason === "sequenceGap") this.queued = reason;
  }
}

export interface SocketCallbacks {
  onState: () => void;
  onFoodAdded: (items: FoodWire[]) => void;
  onPickup: (valueNanos: number, items: FoodWire[]) => void;
  onStatus: (status: ConnectionStatus, detail?: string) => void;
  onLatency: (milliseconds: number) => void;
  onEliminated: (message: EliminatedMessage) => void;
  onReceipt: (message: CashOutReceiptMessage) => void;
  onEntered: (ticketNanos: number) => void;
}

export class GameSocket {
  private socket?: WebSocket;
  private inputTimer?: number;
  private pingTimer?: number;
  private inputSequence = 0;
  private lastSentInput?: SentInput;
  private readonly resync = new ResyncController();
  private resyncing = false;

  constructor(
    readonly replica: Replica,
    private readonly callbacks: SocketCallbacks,
  ) {}

  /** `url` is the arena's absolute `/ws` endpoint, which may be on another region's host. */
  connect(url: string, name: string, skin: string, input: InputState, spectate = false): void {
    this.close();
    this.lastSentInput = undefined;
    this.resync.reset();
    this.resyncing = false;
    this.callbacks.onStatus("connecting");
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ type: "join", protocol: PROTOCOL_VERSION, name, skin, spectate }));
      if (!spectate) this.inputTimer = window.setInterval(() => this.sendInput(input), 1000 / 30);
      this.pingTimer = window.setInterval(() => this.ping(), 2000);
    });
    // A replaced socket (e.g. after switching region) may still deliver events; only the current one counts.
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.receive(event.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.stopTimers();
      this.callbacks.onStatus("disconnected");
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.callbacks.onStatus("error", "WebSocket connection failed");
    });
  }

  reenter(): void {
    this.send({
      type: "reenter",
      stateSequence: this.replica.sequence,
      stateDigest: this.replica.digest,
    });
  }

  cashOut(): void {
    this.send({
      type: "cashOut",
      stateSequence: this.replica.sequence,
      stateDigest: this.replica.digest,
    });
  }

  cancelCashOut(): void {
    this.send({
      type: "cancelCashOut",
      stateSequence: this.replica.sequence,
      stateDigest: this.replica.digest,
    });
  }

  close(): void {
    this.stopTimers();
    this.socket?.close();
    this.socket = undefined;
  }

  private sendInput(input: InputState): void {
    const now = performance.now();
    const due = this.resync.poll(now);
    if (due) this.sendResync(due);
    if (!this.replica.playerId || !shouldSendInput(input, this.lastSentInput, now)) return;
    this.inputSequence += 1;
    this.lastSentInput = { aim: input.aim, boost: input.boost, sentAt: now };
    this.send({
      type: "input",
      inputSeq: this.inputSequence,
      aim: input.aim,
      boost: input.boost,
      stateSequence: this.replica.sequence,
      stateDigest: this.replica.digest,
    });
  }

  private ping(): void {
    this.send({ type: "ping", sentAt: Date.now() });
  }

  private receive(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.callbacks.onStatus("error", "Server sent invalid JSON");
      return;
    }
    if (!isServerMessage(message)) {
      this.callbacks.onStatus("error", "Server sent an unknown message");
      return;
    }
    switch (message.type) {
      case "bootstrap": {
        const now = performance.now();
        const matches = this.replica.applyBootstrap(message);
        if (matches) {
          this.resync.synchronized();
          this.resyncing = false;
          this.callbacks.onStatus("connected", "");
        } else {
          const step = this.resync.digestMismatch(now);
          if (step.resyncing) {
            this.noteResync(step, "Bootstrap digest mismatch");
          } else {
            this.resyncing = false;
            this.callbacks.onStatus("connected", "");
            if (step.send) this.sendResync(step.send);
          }
        }
        this.callbacks.onState();
        break;
      }
      case "delta": {
        if (message.sequence <= this.replica.sequence) break;
        const now = performance.now();
        const expectedSequence = this.replica.sequence + 1;
        const pickupItems = localPickupItems(this.replica, message);
        const synchronized = this.replica.applyDelta(message);
        if (!synchronized) {
          const gap = message.sequence !== expectedSequence;
          const step = gap ? this.resync.sequenceGap(now) : this.resync.digestMismatch(now);
          this.noteResync(step, gap ? "State sequence gap; requesting authority resync" : "State mismatch; requesting authority resync");
        } else {
          this.resync.synchronized();
          if (this.resyncing) {
            this.resyncing = false;
            this.callbacks.onStatus("connected", "");
          }
          if (message.foodAdded.length > 0) this.callbacks.onFoodAdded(message.foodAdded);
          if (pickupItems.length > 0) {
            this.callbacks.onPickup(
              pickupItems.reduce((total, item) => total + item.valueNanos, 0),
              pickupItems,
            );
          }
        }
        this.callbacks.onState();
        break;
      }
      case "entered":
        this.replica.cashOutCompletesAtTick = undefined;
        this.replica.cashOutInheritanceTaxBasisPoints = undefined;
        this.callbacks.onEntered(message.ticketNanos);
        break;
      case "eliminated":
        this.replica.cashOutCompletesAtTick = undefined;
        this.replica.cashOutInheritanceTaxBasisPoints = undefined;
        this.callbacks.onEliminated(message);
        break;
      case "cashOutPending":
        this.replica.cashOutCompletesAtTick = message.completesAtTick;
        this.replica.cashOutInheritanceTaxBasisPoints = message.inheritanceTaxBasisPoints;
        this.callbacks.onState();
        break;
      case "cashOutCanceled":
        this.replica.cashOutCompletesAtTick = undefined;
        this.replica.cashOutInheritanceTaxBasisPoints = undefined;
        this.callbacks.onState();
        break;
      case "cashOutReceipt":
        this.replica.cashOutCompletesAtTick = undefined;
        this.replica.cashOutInheritanceTaxBasisPoints = undefined;
        this.callbacks.onReceipt(message);
        break;
      case "pong":
        this.callbacks.onLatency(Date.now() - message.sentAt);
        break;
      case "error":
        this.callbacks.onStatus("error", `${message.code}: ${message.message}`);
        break;
    }
  }

  private noteResync(step: ResyncStep, detail: string): void {
    if (step.resyncing) {
      this.resyncing = true;
      this.callbacks.onStatus("resyncing", detail);
    }
    if (step.send) this.sendResync(step.send);
  }

  private sendResync(reason: ResyncReason): void {
    this.send({
      type: "resync",
      stateSequence: this.replica.sequence,
      stateDigest: this.replica.digest,
      reason,
    });
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private stopTimers(): void {
    if (this.inputTimer !== undefined) window.clearInterval(this.inputTimer);
    if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer);
    this.inputTimer = undefined;
    this.pingTimer = undefined;
  }
}

export function localPickupItems(replica: Replica, message: DeltaMessage): FoodWire[] {
  const snake = replica.snakes.get(replica.playerId);
  const patch = message.snakesUpdated.find((candidate) => candidate.id === replica.playerId);
  if (!snake || !patch) return [];
  const halfExtent = replica.arenaHalfExtent;
  const endX = snake.x + wrappedDelta(patch.x - snake.x, halfExtent);
  const endY = snake.y + wrappedDelta(patch.y - snake.y, halfExtent);
  const pathX = endX - snake.x;
  const pathY = endY - snake.y;
  const pathLengthSquared = pathX * pathX + pathY * pathY;
  const radius = Math.max(snake.radius, patch.radius);
  return message.foodRemoved.flatMap((id) => {
    const item = replica.food.get(id);
    if (!item) return [];
    const foodX = snake.x + wrappedDelta(item.x - snake.x, halfExtent);
    const foodY = snake.y + wrappedDelta(item.y - snake.y, halfExtent);
    const projection = pathLengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((foodX - snake.x) * pathX + (foodY - snake.y) * pathY) / pathLengthSquared));
    const nearestX = snake.x + pathX * projection;
    const nearestY = snake.y + pathY * projection;
    const reach = radius + item.radius * FOOD_GLOW_RADIUS_MULTIPLIER;
    return (foodX - nearestX) ** 2 + (foodY - nearestY) ** 2 <= reach * reach ? [item] : [];
  });
}

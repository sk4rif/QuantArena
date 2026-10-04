export const PROTOCOL_VERSION = 4;
export const POSITION_SCALE = 100;
export const ANGLE_SCALE = 10_000;
export const NANOS_PER_DOLLAR = 1_000_000_000;

export interface BodyPointWire {
  id: number;
  x: number;
  y: number;
}

export interface SnakeWire {
  id: number;
  name: string;
  skin: string;
  x: number;
  y: number;
  angle: number;
  speed: number;
  radius: number;
  worthNanos: number;
  lastInputSeq: number;
  body: BodyPointWire[];
}

export interface SnakePatch {
  id: number;
  x: number;
  y: number;
  angle: number;
  speed: number;
  radius: number;
  worthNanos: number;
  lastInputSeq: number;
  trimBody: number;
  appendBody: BodyPointWire[];
  replaceBody?: BodyPointWire[];
}

export interface FoodWire {
  id: number;
  x: number;
  y: number;
  radius: number;
  valueNanos: number;
  color: number;
}

export interface LeaderboardEntry {
  id: number;
  name: string;
  worthNanos: number;
}

export interface EconomyConfigWire {
  tier: string;
  tierLabel: string;
  ticketNanos: number;
  denominationsNanos: number[];
  economyTickRate: number;
  treasurySeedNanos: number;
  minimumEffectiveWorthNanos: number;
  taxNumerator: number;
  taxDenominator: number;
  boostNumerator: number;
  boostDenominator: number;
  cashOutDelayTicks: number;
  payoutBasisPoints: number;
  platformFeeBasisPoints: number;
}

export interface EconomyStateWire {
  pendingFloorNanos: number;
  ticketInflowNanos: number;
  payoutsNanos: number;
  platformFeesNanos: number;
}

export interface BootstrapMessage {
  type: "bootstrap";
  protocol: number;
  playerId: number;
  tickRate: number;
  publishRate: number;
  arenaHalfExtent: number;
  cashOutCompletesAtTick: number | null;
  tick: number;
  sequence: number;
  digest: string;
  reason: string;
  economyConfig: EconomyConfigWire;
  economy: EconomyStateWire;
  snakes: SnakeWire[];
  food: FoodWire[];
  leaderboard: LeaderboardEntry[];
}

export interface DeltaMessage {
  type: "delta";
  tick: number;
  sequence: number;
  digest: string;
  economy: EconomyStateWire;
  snakesAdded: SnakeWire[];
  snakesUpdated: SnakePatch[];
  snakesRemoved: number[];
  foodAdded: FoodWire[];
  foodRemoved: number[];
  leaderboard: LeaderboardEntry[];
}

export interface EnteredMessage {
  type: "entered";
  ticketNanos: number;
}

export interface EliminatedMessage {
  type: "eliminated";
  reason: string;
  finalWorthNanos: number;
  ticketNanos: number;
}

export interface CashOutPendingMessage {
  type: "cashOutPending";
  completesAtTick: number;
}

export interface CashOutCanceledMessage {
  type: "cashOutCanceled";
}

export interface CashOutReceiptMessage {
  type: "cashOutReceipt";
  id: number;
  playerId: number;
  playerName: string;
  tier: "paper" | "casual" | "mid" | "standard" | "high" | "elite";
  grossNanos: number;
  payoutNanos: number;
  platformFeeNanos: number;
  reason: "cashOut";
  tick: number;
}

export interface PongMessage {
  type: "pong";
  sentAt: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type ServerMessage =
  | BootstrapMessage
  | DeltaMessage
  | EnteredMessage
  | EliminatedMessage
  | CashOutPendingMessage
  | CashOutCanceledMessage
  | CashOutReceiptMessage
  | PongMessage
  | ErrorMessage;

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return ["bootstrap", "delta", "entered", "eliminated", "cashOutPending", "cashOutCanceled", "cashOutReceipt", "pong", "error"].includes(String(type));
}

export function dequantizePosition(value: number): number {
  return value / POSITION_SCALE;
}

export function dequantizeAngle(value: number): number {
  return value / ANGLE_SCALE;
}

export function formatMoney(nanos: number): string {
  return `$${(nanos / NANOS_PER_DOLLAR).toFixed(nanos < NANOS_PER_DOLLAR ? 3 : 2)}`;
}

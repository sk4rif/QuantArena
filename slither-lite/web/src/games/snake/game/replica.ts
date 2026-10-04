import { stateDigest } from "../net/digest";
import type {
  BootstrapMessage,
  DeltaMessage,
  EconomyConfigWire,
  EconomyStateWire,
  FoodWire,
  LeaderboardEntry,
  SnakePatch,
  SnakeWire,
} from "../net/protocol";

const emptyEconomy: EconomyStateWire = {
  pendingFloorNanos: 0,
  ticketInflowNanos: 0,
  payoutsNanos: 0,
  platformFeesNanos: 0,
};

export class Replica {
  readonly snakes = new Map<number, SnakeWire>();
  readonly food = new Map<number, FoodWire>();
  playerId = 0;
  arenaHalfExtent = 300_000;
  cashOutCompletesAtTick?: number;
  tickRate = 30;
  publishRate = 15;
  tick = 0;
  sequence = 0;
  digest = "0000000000000000";
  leaderboard: LeaderboardEntry[] = [];
  economy: EconomyStateWire = { ...emptyEconomy };
  economyConfig?: EconomyConfigWire;
  synchronized = false;

  applyBootstrap(message: BootstrapMessage): boolean {
    this.snakes.clear();
    this.food.clear();
    for (const snake of message.snakes) this.snakes.set(snake.id, cloneSnake(snake));
    for (const item of message.food) this.food.set(item.id, { ...item });
    this.playerId = message.playerId;
    this.arenaHalfExtent = message.arenaHalfExtent;
    this.cashOutCompletesAtTick = message.cashOutCompletesAtTick ?? undefined;
    this.tickRate = message.tickRate;
    this.publishRate = message.publishRate;
    this.tick = message.tick;
    this.sequence = message.sequence;
    this.economyConfig = { ...message.economyConfig, denominationsNanos: [...message.economyConfig.denominationsNanos] };
    this.economy = { ...message.economy };
    this.leaderboard = message.leaderboard.map((entry) => ({ ...entry }));
    this.digest = stateDigest(this.snakes.values(), this.food.values(), this.economy);
    this.synchronized = this.digest === message.digest;
    return this.synchronized;
  }

  applyDelta(message: DeltaMessage): boolean {
    if (message.sequence !== this.sequence + 1) {
      this.synchronized = false;
      return false;
    }
    for (const id of message.snakesRemoved) {
      this.snakes.delete(id);
      if (id === this.playerId) this.cashOutCompletesAtTick = undefined;
    }
    for (const snake of message.snakesAdded) this.snakes.set(snake.id, cloneSnake(snake));
    for (const patch of message.snakesUpdated) this.applySnakePatch(patch);
    for (const id of message.foodRemoved) this.food.delete(id);
    for (const item of message.foodAdded) this.food.set(item.id, { ...item });
    this.tick = message.tick;
    this.sequence = message.sequence;
    this.economy = { ...message.economy };
    this.leaderboard = message.leaderboard.map((entry) => ({ ...entry }));
    this.digest = stateDigest(this.snakes.values(), this.food.values(), this.economy);
    this.synchronized = this.digest === message.digest;
    return this.synchronized;
  }

  private applySnakePatch(patch: SnakePatch): void {
    const snake = this.snakes.get(patch.id);
    if (!snake) {
      this.synchronized = false;
      return;
    }
    snake.x = patch.x;
    snake.y = patch.y;
    snake.angle = patch.angle;
    snake.speed = patch.speed;
    snake.radius = patch.radius;
    snake.worthNanos = patch.worthNanos;
    snake.lastInputSeq = patch.lastInputSeq;
    if (patch.replaceBody) {
      snake.body = patch.replaceBody.map((point) => ({ ...point }));
    } else {
      snake.body.splice(0, patch.trimBody);
      snake.body.push(...patch.appendBody.map((point) => ({ ...point })));
    }
  }
}

function cloneSnake(snake: SnakeWire): SnakeWire {
  return { ...snake, body: snake.body.map((point) => ({ ...point })) };
}

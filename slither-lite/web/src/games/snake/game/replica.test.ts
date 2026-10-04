import { describe, expect, it } from "vitest";
import { stateDigest } from "../net/digest";
import type { BootstrapMessage, DeltaMessage, EconomyStateWire, SnakeWire } from "../net/protocol";
import { Replica } from "./replica";

const economy: EconomyStateWire = {
  pendingFloorNanos: 0,
  ticketInflowNanos: 5_000_000_000,
  payoutsNanos: 0,
  platformFeesNanos: 0,
};

function snake(): SnakeWire {
  return {
    id: 1,
    name: "Player",
    skin: "red",
    x: 0,
    y: 0,
    angle: 0,
    speed: 15_000,
    radius: 1_200,
    worthNanos: 5_000_000_000,
    lastInputSeq: 0,
    body: [
      { id: 1, x: -2_000, y: 0 },
      { id: 2, x: -1_000, y: 0 },
    ],
  };
}

function bootstrap(): BootstrapMessage {
  const initialSnake = snake();
  return {
    type: "bootstrap",
    protocol: 4,
    playerId: 1,
    tickRate: 30,
    publishRate: 15,
    arenaHalfExtent: 300_000,
    cashOutCompletesAtTick: null,
    tick: 1,
    sequence: 1,
    digest: stateDigest([initialSnake], [], economy),
    reason: "joined",
    economyConfig: {
      tier: "casual",
      tierLabel: "Casual",
      ticketNanos: 5_000_000_000,
      denominationsNanos: [1_000_000_000, 500_000_000, 100_000_000, 10_000_000, 5_000_000],
      economyTickRate: 30,
      treasurySeedNanos: 100_000_000_000,
      minimumEffectiveWorthNanos: 5_000_000_000,
      taxNumerator: 5,
      taxDenominator: 100_000,
      boostNumerator: 2_667,
      boostDenominator: 2_000_000,
      cashOutDelayTicks: 300,
      payoutBasisPoints: 9_500,
      platformFeeBasisPoints: 500,
    },
    economy,
    snakes: [initialSnake],
    food: [],
    leaderboard: [],
  };
}

describe("Replica", () => {
  it("atomically bootstraps and applies append/trim deltas", () => {
    const replica = new Replica();
    expect(replica.applyBootstrap(bootstrap())).toBe(true);
    const result = snake();
    result.x = 500;
    result.worthNanos -= 250_000;
    result.body = [
      { id: 2, x: -1_000, y: 0 },
      { id: 3, x: 0, y: 0 },
    ];
    const nextEconomy = { ...economy, pendingFloorNanos: 250_000 };
    const delta: DeltaMessage = {
      type: "delta",
      tick: 3,
      sequence: 2,
      digest: stateDigest([result], [], nextEconomy),
      economy: nextEconomy,
      snakesAdded: [],
      snakesUpdated: [{
        id: 1,
        x: 500,
        y: 0,
        angle: 0,
        speed: 15_000,
        radius: 1_200,
        worthNanos: result.worthNanos,
        lastInputSeq: 0,
        trimBody: 1,
        appendBody: [{ id: 3, x: 0, y: 0 }],
      }],
      snakesRemoved: [],
      foodAdded: [],
      foodRemoved: [],
      leaderboard: [],
    };
    expect(replica.applyDelta(delta)).toBe(true);
    expect(replica.snakes.get(1)?.body.map((point) => point.id)).toEqual([2, 3]);
    expect(replica.snakes.get(1)?.worthNanos).toBe(4_999_750_000);
  });

  it("restores an authoritative pending cash-out from bootstrap", () => {
    const replica = new Replica();
    const message = bootstrap();
    message.cashOutCompletesAtTick = 301;
    replica.applyBootstrap(message);
    expect(replica.cashOutCompletesAtTick).toBe(301);
  });

  it("rejects a sequence gap", () => {
    const replica = new Replica();
    replica.applyBootstrap(bootstrap());
    const delta = { type: "delta", sequence: 3 } as DeltaMessage;
    expect(replica.applyDelta(delta)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { stateDigest } from "../net/digest";
import { localPickupItems } from "../net/socket";
import type { BootstrapMessage, DeltaMessage, EconomyStateWire, SnakeWire } from "../net/protocol";
import { BodyInterpolation, LocalPrediction, RemoteInterpolation } from "./prediction";
import { Replica } from "./replica";

const economy: EconomyStateWire = {
  pendingFloorNanos: 0,
  ticketInflowNanos: 5_000_000_000,
  payoutsNanos: 0,
  platformFeesNanos: 0,
  floorLiquidityRatioPpm: 500_000,
  starvationTaxNumerator: 60_969,
  inheritanceTaxBasisPoints: 1_100,
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
    protocol: 5,
    playerId: 1,
    tickRate: 30,
    publishRate: 15,
    arenaHalfExtent: 300_000,
    cashOutCompletesAtTick: null,
    cashOutInheritanceTaxBasisPoints: null,
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
      initialTreasuryNanos: 80_000_000_000,
      minimumEffectiveWorthNanos: 5_000_000_000,
      liquidityRatioLowPpm: 250_000,
      liquidityRatioHighPpm: 650_000,
      starvationMinNumerator: 25_672,
      starvationMaxNumerator: 96_266,
      starvationDenominator: 1_000_000_000,
      inheritanceTaxMinBasisPoints: 200,
      inheritanceTaxMaxBasisPoints: 2_000,
      boostNumerator: 2_667,
      boostDenominator: 2_000_000,
      cashOutDelayTicks: 300,
      platformFeeBasisPoints: 200,
    },
    economy,
    snakes: [initialSnake],
    food: [],
    leaderboard: [],
  };
}

describe("RemoteInterpolation", () => {
  it("smooths remote positions across frames and arena wrapping", () => {
    const replica = new Replica();
    const remote = snake();
    remote.id = 2;
    remote.x = 299_900;
    replica.snakes.set(remote.id, remote);
    replica.playerId = 1;
    replica.publishRate = 10;
    const interpolation = new RemoteInterpolation();
    interpolation.reconcile(replica, 0);

    remote.x = -299_900;
    interpolation.reconcile(replica, 0);

    expect(interpolation.pose(remote.id, 0)?.x).toBeCloseTo(2_999);
    expect(interpolation.pose(remote.id, 50)?.x).toBeCloseTo(3_000);
    expect(interpolation.pose(remote.id, 100)?.x).toBeCloseTo(3_001);
  });

  it("takes the shortest path between remote angles", () => {
    const replica = new Replica();
    const remote = snake();
    remote.id = 2;
    remote.angle = Math.round((Math.PI - 0.1) * 10_000);
    replica.snakes.set(remote.id, remote);
    replica.playerId = 1;
    replica.publishRate = 10;
    const interpolation = new RemoteInterpolation();
    interpolation.reconcile(replica, 0);

    remote.angle = Math.round((-Math.PI + 0.1) * 10_000);
    interpolation.reconcile(replica, 0);

    expect(Math.abs(interpolation.pose(remote.id, 50)!.angle)).toBeCloseTo(Math.PI, 3);
  });
});

describe("BodyInterpolation", () => {
  it("moves visual slots forward when authoritative trail points are trimmed and appended", () => {
    const replica = new Replica();
    const moving = snake();
    replica.snakes.set(moving.id, moving);
    const interpolation = new BodyInterpolation();
    interpolation.reconcile(replica, 0);

    moving.body = [
      { id: 2, x: -1_000, y: 0 },
      { id: 3, x: 0, y: 0 },
    ];
    interpolation.reconcile(replica, 0);

    expect(interpolation.points(moving.id, 1_000 / 30)).toEqual([
      { x: -15, y: 0 },
      { x: -5, y: 0 },
    ]);
    expect(interpolation.points(moving.id, 1_000 / 15)).toEqual([
      { x: -10, y: 0 },
      { x: 0, y: 0 },
    ]);
  });

  it("resamples the trail from the rendered head so the leading segment stays attached", () => {
    const replica = new Replica();
    const moving = snake();
    replica.snakes.set(moving.id, moving);
    const interpolation = new BodyInterpolation();
    interpolation.reconcile(replica, 0);

    const trail = interpolation.trail(moving.id, { x: 5, y: 0 }, 3_000, 0);

    expect(trail).toEqual([
      { x: -20, y: 0 },
      { x: -7.5, y: 0 },
    ]);
    expect(5 - trail![1]!.x).toBe(12.5);
  });

  it("preserves the authoritative tail when boost-spaced samples exceed ten units", () => {
    const replica = new Replica();
    const moving = snake();
    moving.body = [
      { id: 1, x: -2_934, y: 0 },
      { id: 2, x: -1_467, y: 0 },
    ];
    replica.snakes.set(moving.id, moving);
    const interpolation = new BodyInterpolation();
    interpolation.reconcile(replica, 0);

    const trail = interpolation.trail(moving.id, { x: 0, y: 0 }, 3_000, 0);

    expect(trail?.[0]?.x).toBeCloseTo(-29.34);
    expect(trail?.[1]?.x).toBeCloseTo(-14.67);
  });

  it("does not restart motion when a delta leaves the body unchanged", () => {
    const replica = new Replica();
    const moving = snake();
    replica.snakes.set(moving.id, moving);
    const interpolation = new BodyInterpolation();
    interpolation.reconcile(replica, 0);
    moving.body = [
      { id: 2, x: -1_000, y: 0 },
      { id: 3, x: 0, y: 0 },
    ];
    interpolation.reconcile(replica, 0);
    interpolation.reconcile(replica, 1_000 / 30);

    expect(interpolation.points(moving.id, 1_000 / 15)?.[0]?.x).toBe(-10);
  });

  it("takes the shortest path across an arena seam", () => {
    const replica = new Replica();
    const moving = snake();
    moving.body = [{ id: 1, x: 299_900, y: 0 }];
    replica.snakes.set(moving.id, moving);
    const interpolation = new BodyInterpolation();
    interpolation.reconcile(replica, 0);
    moving.body = [{ id: 2, x: -299_900, y: 0 }];
    interpolation.reconcile(replica, 0);

    expect(interpolation.points(moving.id, 1_000 / 30)?.[0]?.x).toBeCloseTo(3_000);
  });
});

describe("localPickupItems", () => {
  it("keeps removed food touched by the local movement path for absorption effects", () => {
    const replica = new Replica();
    const local = snake();
    replica.playerId = local.id;
    replica.snakes.set(local.id, local);
    replica.food.set(10, { id: 10, x: 3_000, y: 0, radius: 600, valueNanos: 500_000_000, color: 1 });
    replica.food.set(11, { id: 11, x: 5_000, y: 0, radius: 600, valueNanos: 500_000_000, color: 1 });
    const message: DeltaMessage = {
      type: "delta",
      tick: 2,
      sequence: 1,
      digest: "0000000000000000",
      economy,
      snakesAdded: [],
      snakesUpdated: [{
        id: local.id,
        x: 1_000,
        y: 0,
        angle: 0,
        speed: local.speed,
        radius: local.radius,
        worthNanos: local.worthNanos + 500_000_000,
        lastInputSeq: 0,
        trimBody: 0,
        appendBody: [],
      }],
      snakesRemoved: [],
      foodAdded: [],
      foodRemoved: [10, 11],
      leaderboard: [],
    };

    expect(localPickupItems(replica, message).map((item) => item.id)).toEqual([10]);
  });
});

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
    message.cashOutInheritanceTaxBasisPoints = 1_100;
    replica.applyBootstrap(message);
    expect(replica.cashOutCompletesAtTick).toBe(301);
    expect(replica.cashOutInheritanceTaxBasisPoints).toBe(1_100);
  });

  it("rejects a sequence gap", () => {
    const replica = new Replica();
    replica.applyBootstrap(bootstrap());
    const delta = { type: "delta", sequence: 3 } as DeltaMessage;
    expect(replica.applyDelta(delta)).toBe(false);
  });

  it("keeps economy and leaderboard when a delta omits them", () => {
    const replica = new Replica();
    expect(replica.applyBootstrap(bootstrap())).toBe(true);
    const kept = [{ id: 1, name: "Player", worthNanos: 5_000_000_000 }];
    replica.leaderboard = kept.map((entry) => ({ ...entry }));
    const delta: DeltaMessage = {
      type: "delta",
      tick: 2,
      sequence: 2,
      digest: replica.digest,
      snakesAdded: [],
      snakesUpdated: [],
      snakesRemoved: [],
      foodAdded: [],
      foodRemoved: [],
    };
    expect(replica.applyDelta(delta)).toBe(true);
    expect(replica.economy).toEqual(economy);
    expect(replica.leaderboard).toEqual(kept);
    expect(replica.snakes.get(1)?.x).toBe(0);
  });

  it("replaces the leaderboard when a delta sends an empty one", () => {
    const replica = new Replica();
    replica.applyBootstrap(bootstrap());
    replica.leaderboard = [{ id: 1, name: "Player", worthNanos: 5_000_000_000 }];
    const delta: DeltaMessage = {
      type: "delta",
      tick: 2,
      sequence: 2,
      digest: replica.digest,
      snakesAdded: [],
      snakesUpdated: [],
      snakesRemoved: [],
      foodAdded: [],
      foodRemoved: [],
      leaderboard: [],
    };
    expect(replica.applyDelta(delta)).toBe(true);
    expect(replica.leaderboard).toEqual([]);
  });
});

describe("LocalPrediction", () => {
  it("steers from the live aim while the acknowledged input sequence stays put", () => {
    const replica = new Replica();
    const local = snake();
    local.lastInputSeq = 4;
    replica.playerId = local.id;
    replica.snakes.set(local.id, local);
    const prediction = new LocalPrediction();
    prediction.reconcile(replica);
    prediction.update(replica, { aim: Math.PI / 2, boost: false, panX: 0, panY: 0 }, 1);
    expect(local.lastInputSeq).toBe(4);
    expect(prediction.angle).toBeCloseTo(Math.PI / 2, 5);
    expect(prediction.y).toBeGreaterThan(100);
  });

  it("does not drag the snake backward toward a stale snapshot", () => {
    const replica = new Replica();
    const local = snake();
    replica.playerId = local.id;
    replica.snakes.set(local.id, local);
    const prediction = new LocalPrediction();
    prediction.reconcile(replica);
    const aim = { aim: 0, boost: false, panX: 0, panY: 0 };
    prediction.update(replica, aim, 0.2);
    const ahead = prediction.x;
    expect(ahead).toBeGreaterThan(20);
    prediction.reconcile(replica);
    expect(prediction.x).toBeGreaterThanOrEqual(ahead - 1e-6);
  });
});

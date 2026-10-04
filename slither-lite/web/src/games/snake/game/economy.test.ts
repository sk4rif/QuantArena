import { describe, expect, it } from "vitest";
import type { EconomyConfigWire } from "../net/protocol";
import { calculateSnakeEconomyMetrics, WorthRateTracker } from "./economy";

const config: EconomyConfigWire = {
  tier: "casual",
  tierLabel: "Casual",
  ticketNanos: 5_000_000_000,
  denominationsNanos: [],
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
};

describe("calculateSnakeEconomyMetrics", () => {
  it("matches the 30 Hz Casual formula rates", () => {
    const metrics = calculateSnakeEconomyMetrics(5_000_000_000, true, config);
    expect(metrics.taxPerSecondNanos).toBe(7_500_000);
    expect(metrics.boostPerSecondNanos).toBe(200_025_000);
    expect(metrics.currentBurnPerSecondNanos).toBe(207_525_000);
    expect(metrics.cashOutValueNanos).toBe(4_750_000_000);
  });

  it("excludes potential boost burn when boost is inactive", () => {
    const metrics = calculateSnakeEconomyMetrics(5_000_000_000, false, config);
    expect(metrics.currentBurnPerSecondNanos).toBe(metrics.taxPerSecondNanos);
  });
});

describe("WorthRateTracker", () => {
  it("calculates signed worth change from authoritative ticks", () => {
    const tracker = new WorthRateTracker(3);
    expect(tracker.update(0, 5_000_000_000, 30)).toBe(0);
    expect(tracker.update(30, 6_000_000_000, 30)).toBe(1_000_000_000);
    expect(tracker.update(60, 5_500_000_000, 30)).toBe(250_000_000);
  });

  it("resets when the snake leaves the arena", () => {
    const tracker = new WorthRateTracker();
    tracker.update(0, 5_000_000_000, 30);
    tracker.update(30, 6_000_000_000, 30);
    expect(tracker.update(31, undefined, 30)).toBe(0);
    expect(tracker.update(60, 5_000_000_000, 30)).toBe(0);
  });
});

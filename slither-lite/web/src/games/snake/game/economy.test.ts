import { describe, expect, it } from "vitest";
import type { EconomyConfigWire } from "../net/protocol";
import { calculateSnakeEconomyMetrics, WorthRateTracker } from "./economy";

const config: EconomyConfigWire = {
  tier: "casual",
  tierLabel: "Casual",
  ticketNanos: 5_000_000_000,
  denominationsNanos: [],
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
  boostDenominator: 4_000_000,
  cashOutDelayTicks: 300,
  platformFeeBasisPoints: 200,
};

const economy = {
  pendingFloorNanos: 0,
  ticketInflowNanos: 5_000_000_000,
  payoutsNanos: 0,
  platformFeesNanos: 0,
  floorLiquidityRatioPpm: 450_000,
  starvationTaxNumerator: 60_969,
  inheritanceTaxBasisPoints: 1_100,
};

describe("calculateSnakeEconomyMetrics", () => {
  it("matches the 30 Hz Casual formula rates", () => {
    const metrics = calculateSnakeEconomyMetrics(5_000_000_000, true, config, economy);
    expect(metrics.taxPerTickNanos).toBe(304_845);
    expect(metrics.taxPerSecondNanos).toBe(9_145_350);
    expect(metrics.starvationHalfLifeSeconds).toBeGreaterThan(300);
    expect(metrics.starvationHalfLifeSeconds).toBeLessThan(420);
    expect(metrics.boostPerSecondNanos).toBe(100_012_500);
    expect(metrics.currentBurnPerSecondNanos).toBe(109_157_850);
    expect(metrics.floorLiquidityRatioPpm).toBe(450_000);
    expect(metrics.regimePosition).toBe(0.5);
    expect(metrics.inheritanceTaxBasisPoints).toBe(1_100);
    expect(metrics.inheritanceTaxNanos).toBe(550_000_000);
    expect(metrics.platformFeeNanos).toBe(89_000_000);
    expect(metrics.grossCashOutNanos).toBe(5_000_000_000);
    expect(metrics.cashOutValueNanos).toBe(4_361_000_000);
  });

  it("excludes potential boost burn when boost is inactive", () => {
    const metrics = calculateSnakeEconomyMetrics(5_000_000_000, false, config, economy);
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

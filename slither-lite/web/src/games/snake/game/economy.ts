import type { EconomyConfigWire } from "../net/protocol";

interface WorthSample {
  tick: number;
  worthNanos: number;
}

export class WorthRateTracker {
  private readonly samples: WorthSample[] = [];

  constructor(private readonly windowSeconds = 3) {}

  update(tick: number, worthNanos: number | undefined, tickRate: number): number {
    if (worthNanos === undefined || tickRate <= 0) {
      this.samples.length = 0;
      return 0;
    }
    const latest = this.samples.at(-1);
    if (latest && tick < latest.tick) this.samples.length = 0;
    const current = this.samples.at(-1);
    if (current?.tick === tick) {
      current.worthNanos = worthNanos;
    } else {
      this.samples.push({ tick, worthNanos });
    }
    const minimumTick = tick - this.windowSeconds * tickRate;
    while (this.samples.length > 2 && (this.samples[1]?.tick ?? tick) <= minimumTick) this.samples.shift();
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || first.tick === last.tick) return 0;
    return ((last.worthNanos - first.worthNanos) * tickRate) / (last.tick - first.tick);
  }
}

export interface SnakeEconomyMetrics {
  taxPerSecondNanos: number;
  boostPerSecondNanos: number;
  currentBurnPerSecondNanos: number;
  cashOutValueNanos: number;
}

export function calculateSnakeEconomyMetrics(
  worthNanos: number,
  boosting: boolean,
  config: EconomyConfigWire,
): SnakeEconomyMetrics {
  const effectiveWorth = Math.max(worthNanos, config.minimumEffectiveWorthNanos);
  const taxPerSecondNanos =
    (effectiveWorth * config.taxNumerator * config.economyTickRate) / config.taxDenominator;
  const boostPerSecondNanos =
    (effectiveWorth * config.boostNumerator * config.economyTickRate) / config.boostDenominator;
  const platformFee = Math.floor((worthNanos * config.platformFeeBasisPoints) / 10_000);
  return {
    taxPerSecondNanos,
    boostPerSecondNanos,
    currentBurnPerSecondNanos: taxPerSecondNanos + (boosting ? boostPerSecondNanos : 0),
    cashOutValueNanos: worthNanos - platformFee,
  };
}

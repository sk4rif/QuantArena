import { describe, expect, it } from "vitest";
import type { FoodWire } from "../net/protocol";
import { aumWeightAt, buildMoneyGrid, economicHeatIntensity, spawnPoint } from "./minimap";

function ball(id: number, x: number, y: number, valueNanos: number): FoodWire {
  return { id, x: x * 100, y: y * 100, radius: 500, valueNanos, color: 0 };
}

describe("buildMoneyGrid", () => {
  it("preserves total collectible value while aggregating concentration", () => {
    const grid = buildMoneyGrid([
      ball(1, 0, 0, 1_000_000_000),
      ball(2, 10, 10, 500_000_000),
      ball(3, -2_000, -2_000, 100_000_000),
    ], 3_000, 12);
    expect(grid.total).toBe(1_600_000_000);
    expect([...grid.cells].reduce((total, value) => total + value, 0)).toBe(grid.total);
    expect(grid.maximum).toBe(1_500_000_000);
  });

  it("weights color intensity by economic value rather than object presence", () => {
    const microDrop = economicHeatIntensity(5_000_000, 1_000_000_000);
    const oneDollar = economicHeatIntensity(1_000_000_000, 1_000_000_000);
    expect(oneDollar).toBe(1);
    expect(microDrop).toBeLessThan(0.08);
    expect(oneDollar).toBeGreaterThan(microDrop * 10);
  });

  it("ignores coordinates outside the arena projection", () => {
    const grid = buildMoneyGrid([ball(1, 4_000, 0, 1_000_000_000)], 3_000, 12);
    expect(grid.total).toBe(0);
    expect(grid.maximum).toBe(0);
  });
});

describe("spawnPoint", () => {
  const stakes = [
    { x: 100_000, y: 0, worthNanos: 30 },
    { x: 0, y: 100_000, worthNanos: 10 },
  ];

  it("picks the lowest-weight cell of the arena", () => {
    const point = spawnPoint(stakes, 3_000);
    expect(point).toBeDefined();
    const weight = aumWeightAt(point!.x, point!.y, stakes);
    const cell = 6_000 / 64;
    for (let row = 0; row < 64; row += 1) {
      for (let column = 0; column < 64; column += 1) {
        const x = -3_000 + (column + 0.5) * cell;
        const y = -3_000 + (row + 0.5) * cell;
        if (x * x + y * y <= 2_850 * 2_850) expect(aumWeightAt(x, y, stakes)).toBeGreaterThanOrEqual(weight);
      }
    }
    expect(point!.x).toBeLessThan(0);
    expect(point!.y).toBeLessThan(0);
  });

  it("is pushed away from the heavier snake", () => {
    const nearRich = spawnPoint([{ x: 100_000, y: 0, worthNanos: 100 }, { x: -100_000, y: 0, worthNanos: 1 }], 3_000);
    const nearPoor = spawnPoint([{ x: 100_000, y: 0, worthNanos: 1 }, { x: -100_000, y: 0, worthNanos: 100 }], 3_000);
    expect(nearRich!.x).toBeLessThan(0);
    expect(nearPoor!.x).toBeGreaterThan(0);
  });

  it("is undefined without AUM", () => {
    expect(spawnPoint([], 3_000)).toBeUndefined();
    expect(spawnPoint([{ x: 1, y: 1, worthNanos: 0 }], 3_000)).toBeUndefined();
  });
});

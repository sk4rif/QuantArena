import { describe, expect, it } from "vitest";
import fixtureFile from "./digest-fixtures.json";
import { stateDigest } from "./digest";
import type { EconomyStateWire, FoodWire, SnakeWire } from "./protocol";

interface DigestCase {
  name: string;
  snakes: SnakeWire[];
  food: FoodWire[];
  economy: EconomyStateWire;
  digest: string;
}

const cases = fixtureFile.cases as DigestCase[];

const snake: SnakeWire = {
  id: 7,
  name: "Ada",
  skin: "red",
  x: 100,
  y: -50,
  angle: 10,
  speed: 15_000,
  radius: 1_200,
  worthNanos: 5_125_000_000,
  lastInputSeq: 2,
  body: [{ id: 9, x: 80, y: -50 }],
};
const first: FoodWire = { id: 2, x: 0, y: 1, radius: 300, valueNanos: 5_000_000, color: 1 };
const second: FoodWire = { id: 1, x: 2, y: 3, radius: 300, valueNanos: 10_000_000, color: 2 };
const economy: EconomyStateWire = {
  pendingFloorNanos: 1,
  ticketInflowNanos: 5_000_000_000,
  payoutsNanos: 0,
  platformFeesNanos: 0,
  floorLiquidityRatioPpm: 500_000,
  starvationTaxNumerator: 60_969,
  inheritanceTaxBasisPoints: 1_100,
};

describe("stateDigest", () => {
  it("matches the canonical Rust fixture", () => {
    expect(stateDigest([snake], [first, second], economy)).toBe("482f1f709e0b180f");
  });

  it("sorts entities by ID", () => {
    expect(stateDigest([snake], [second, first], economy)).toBe(stateDigest([snake], [first, second], economy));
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("matches the shared fixture %s", (_name, entry) => {
    expect(stateDigest(entry.snakes, entry.food, entry.economy)).toBe(entry.digest);
    expect(stateDigest([...entry.snakes].reverse(), [...entry.food].reverse(), entry.economy)).toBe(entry.digest);
  });

  it("hashes body points in wire order rather than by sample id", () => {
    const left = cases.find((entry) => entry.name === "body-order-a");
    const right = cases.find((entry) => entry.name === "body-order-b");
    expect(left?.digest).not.toBe(right?.digest);
  });
});

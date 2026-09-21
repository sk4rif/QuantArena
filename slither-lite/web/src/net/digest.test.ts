import { describe, expect, it } from "vitest";
import { stateDigest } from "./digest";
import type { EconomyStateWire, FoodWire, SnakeWire } from "./protocol";

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
};

describe("stateDigest", () => {
  it("matches the canonical Rust fixture", () => {
    expect(stateDigest([snake], [first, second], economy)).toBe("748a7b255b049176");
  });

  it("sorts entities by ID", () => {
    expect(stateDigest([snake], [second, first], economy)).toBe(stateDigest([snake], [first, second], economy));
  });
});

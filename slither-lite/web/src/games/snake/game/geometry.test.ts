import { describe, expect, it } from "vitest";
import { nearestWrappedCoordinate, wrapCoordinate, wrappedDelta } from "./geometry";

describe("toroidal geometry", () => {
  it("wraps coordinates into the square", () => {
    expect(wrapCoordinate(3_004, 3_000)).toBe(-2_996);
    expect(wrapCoordinate(-3_007, 3_000)).toBe(2_993);
  });

  it("selects the nearest image across a seam", () => {
    expect(nearestWrappedCoordinate(-2_998, 3_002, 3_000)).toBe(3_002);
    expect(wrappedDelta(5_990, 3_000)).toBe(-10);
  });
});

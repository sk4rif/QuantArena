import { describe, expect, it } from "vitest";
import { gravitationalOffset, nearestWrappedCoordinate, wrapCoordinate, wrappedDelta } from "./geometry";

describe("toroidal geometry", () => {
  it("wraps coordinates into the square", () => {
    expect(wrapCoordinate(3_004, 3_000)).toBe(-2_996);
    expect(wrapCoordinate(-3_007, 3_000)).toBe(2_993);
  });

  it("selects the nearest image across a seam", () => {
    expect(nearestWrappedCoordinate(-2_998, 3_002, 3_000)).toBe(3_002);
    expect(wrappedDelta(5_990, 3_000)).toBe(-10);
  });

  it("pulls a core toward an attractor without crossing its glow boundary", () => {
    const boundaryRadius = 16.8;
    const coreRadius = 4.32;
    const offset = gravitationalOffset(28.8, 0, boundaryRadius, coreRadius, 12);

    expect(offset.x).toBeCloseTo(boundaryRadius - coreRadius);
    expect(Math.hypot(offset.x, offset.y) + coreRadius).toBeCloseTo(boundaryRadius);
    expect(gravitationalOffset(100, 0, boundaryRadius, coreRadius, 12)).toEqual({ x: 0, y: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { edgePanAxis } from "../game/input";
import type { FoodWire } from "../net/protocol";
import { Camera } from "./camera";
import { adversarySkin, foodValueColor, foodValueConcentration, groupFoodByPosition } from "./renderer";

function food(id: number, x: number, y: number, radius = 600, valueNanos = 50_000_000): FoodWire {
  return { id, x, y, radius, valueNanos, color: 1 };
}

describe("spectator edge panning", () => {
  it("activates only near the viewport edges", () => {
    expect(edgePanAxis(20, 1_000)).toBe(-1);
    expect(edgePanAxis(500, 1_000)).toBe(0);
    expect(edgePanAxis(980, 1_000)).toBe(1);
  });
});

describe("Camera", () => {
  it("pans at a consistent screen speed and normalizes diagonal movement", () => {
    const horizontal = new Camera();
    horizontal.pan(1, 0, .5);

    const diagonal = new Camera();
    diagonal.pan(1, 1, .5);

    expect(horizontal.x).toBe(360);
    expect(horizontal.y).toBe(0);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(360);
  });

  it("accounts for zoom while panning", () => {
    const camera = new Camera();
    camera.zoom = .5;
    camera.pan(-1, 0, .5);

    expect(camera.x).toBe(-720);
  });
});

describe("adversarySkin", () => {
  it("assigns stable varied non-red skins", () => {
    expect(adversarySkin(42)).toBe(adversarySkin(42));
    const skins = new Set(Array.from({ length: 20 }, (_, index) => adversarySkin(index + 1)));
    expect(skins.size).toBeGreaterThanOrEqual(4);
    expect(skins.has("red")).toBe(false);
  });
});

describe("groupFoodByPosition", () => {
  it("combines food at identical wire coordinates into one render group", () => {
    const groups = groupFoodByPosition([
      food(1, 100, 200, 500),
      food(2, 100, 200, 700),
      food(3, 101, 200, 600),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      id: 1,
      ids: [1, 2],
      x: 100,
      y: 200,
      radius: 700,
      count: 2,
      valueNanos: 100_000_000,
    });
    expect(groups[1]?.count).toBe(1);
  });

  it("supports replica map iterators without changing authoritative entities", () => {
    const items = new Map([
      [1, food(1, -200, 300)],
      [2, food(2, -200, 300)],
      [3, food(3, -200, 300)],
    ]);

    expect(groupFoodByPosition(items.values())[0]?.count).toBe(3);
    expect(items.size).toBe(3);
  });

  it("bases visual concentration on total currency value rather than entity count", () => {
    const baseValue = 50_000_000;
    const stacked = groupFoodByPosition([
      food(1, 0, 0, 500, 25_000_000),
      food(2, 0, 0, 500, 25_000_000),
    ])[0]!;
    const larger = groupFoodByPosition([food(3, 100, 0, 700, 200_000_000)])[0]!;

    expect(foodValueConcentration(stacked.valueNanos, baseValue)).toBe(0);
    expect(foodValueConcentration(larger.valueNanos, baseValue)).toBeGreaterThan(
      foodValueConcentration(stacked.valueNanos, baseValue),
    );
  });

  it("uses pale green for low value and deep green for high value", () => {
    expect(foodValueColor(0)).toEqual({ red: 147, green: 217, blue: 163 });
    expect(foodValueColor(1)).toEqual({ red: 20, green: 106, blue: 51 });
    expect(foodValueColor(.5).green).toBeLessThan(foodValueColor(0).green);
  });
});

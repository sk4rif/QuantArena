import { describe, expect, it } from "vitest";
import { defaultLevel, findGame, findLevel, games, NANOS_PER_DOLLAR } from ".";

describe("catalog", () => {
  it("lists the snake game", () => {
    expect(findGame("snake")?.name).toBe("QuantArena");
    expect(findGame("missing")).toBeUndefined();
  });

  it("matches the tier tickets the server charges", () => {
    const game = findGame("snake")!;
    const stakes = Object.fromEntries(game.levels.map((level) => [level.key, level.stakeNanos / NANOS_PER_DOLLAR]));
    expect(stakes).toEqual({ paper: 5, casual: 5, mid: 25, standard: 50, high: 100, elite: 150 });
  });

  it("opens only the paper level for now", () => {
    const game = findGame("snake")!;
    expect(game.levels.filter((level) => level.availability === "open").map((level) => level.key)).toEqual(["paper"]);
    expect(defaultLevel(game)?.key).toBe("paper");
    expect(findLevel(game, "elite")?.availability).toBe("comingSoon");
  });

  it("uses unique game and level ids", () => {
    expect(new Set(games.map((game) => game.id)).size).toBe(games.length);
    for (const game of games) {
      expect(new Set(game.levels.map((level) => level.key)).size).toBe(game.levels.length);
    }
  });
});

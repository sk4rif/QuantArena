import { describe, expect, it } from "vitest";
import { playPath } from "../../../site/routes";
import { snakeGame } from "..";
import { renderLevels } from "./levels";

describe("renderLevels", () => {
  it("links open levels to the arena and leaves locked ones unlinked", () => {
    const html = renderLevels("snake");
    const game = snakeGame;
    for (const level of game.levels) {
      const href = `href="${playPath(game.id, level.key)}"`;
      if (level.availability === "open") expect(html).toContain(href);
      else expect(html).not.toContain(href);
    }
  });

  it("shows a disabled action for every level that is not open", () => {
    const game = snakeGame;
    const locked = game.levels.filter((level) => level.availability !== "open").length;
    expect(renderLevels("snake").match(/Coming soon/g)).toHaveLength(locked);
  });

  it("shows the paper level as free, with no price anywhere on its card", () => {
    const card = renderLevels("snake").split('<div class="card card-level')[1]!;
    expect(card).toContain("PaperArena");
    expect(card).toContain("Free");
    expect(card).toContain(">Play<");
    expect(card).not.toContain("$5.00");
  });

  it("still prices the levels that charge real money", () => {
    const html = renderLevels("snake");
    expect(html).toContain("$5.00");
    expect(html).toContain("$150.00");
  });

  it("reports unknown games instead of rendering an empty page", () => {
    const html = renderLevels("nope");
    expect(html).toContain("Game not found");
    expect(html).not.toContain('href="#/play');
  });
});

import { describe, expect, it } from "vitest";
import { games } from "../catalog";
import { gamePath } from "../routes";
import { renderHome } from "./home";

describe("renderHome", () => {
  it("links every game to its level-select page, never straight to an arena", () => {
    const html = renderHome();
    for (const game of games) expect(html).toContain(`href="${gamePath(game.id)}"`);
    expect(html).not.toContain('href="#/play');
  });

  it("names the games it lists", () => {
    expect(renderHome()).toContain("QuantArena");
  });

  it("summarises stakes from free rather than from the paper ticket", () => {
    expect(renderHome()).toContain("Free – $150.00");
  });

  it("leads with the game list rather than the platform pitch", () => {
    const html = renderHome();
    expect(html).not.toContain("Skillz hosts games");
    expect(html).not.toContain("How a game works");
  });
});

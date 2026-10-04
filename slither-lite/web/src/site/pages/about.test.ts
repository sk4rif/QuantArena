import { describe, expect, it } from "vitest";
import { renderAbout } from "./about";

describe("renderAbout", () => {
  it("carries the platform explanation moved off the game list", () => {
    const html = renderAbout();
    expect(html).toContain("Zero Sum hosts games");
    expect(html).toContain("How a game works");
  });
});

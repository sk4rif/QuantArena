import { describe, expect, it } from "vitest";
import { gamePath, navRoutesFor, parseLocation, parseRoute, playPath } from "./routes";

describe("parseRoute", () => {
  it("maps known hashes to routes", () => {
    expect(parseRoute("#/")).toBe("home");
    expect(parseRoute("#/about")).toBe("about");
    expect(parseRoute("#/game/snake")).toBe("game");
    expect(parseRoute("#/play")).toBe("play");
    expect(parseRoute("#/rules")).toBe("rules");
    expect(parseRoute("#/docs")).toBe("docs");
  });

  it("ignores nested segments and query strings", () => {
    expect(parseRoute("#/docs/messages")).toBe("docs");
    expect(parseRoute("#/rules?x=1")).toBe("rules");
  });

  it("falls back to the game list for empty or unknown hashes", () => {
    expect(parseRoute("")).toBe("home");
    expect(parseRoute("#")).toBe("home");
    expect(parseRoute("#/nope")).toBe("home");
  });
});

describe("parseLocation", () => {
  it("returns the section for nested hashes", () => {
    expect(parseLocation("#/docs/errors")).toEqual({ route: "docs", section: "errors" });
    expect(parseLocation("#/rules/cashout?x=1")).toEqual({ route: "rules", section: "cashout" });
  });

  it("returns the game id and level key for arena hashes", () => {
    expect(parseLocation("#/play/snake/paper")).toEqual({ route: "play", section: "snake", detail: "paper" });
    expect(parseLocation("#/game/snake")).toEqual({ route: "game", section: "snake" });
  });

  it("omits the section when absent", () => {
    expect(parseLocation("#/rules")).toEqual({ route: "rules" });
    expect(parseLocation("#/unknown/errors")).toEqual({ route: "home" });
  });
});

describe("path builders", () => {
  it("round-trips through parseLocation", () => {
    expect(parseLocation(gamePath("snake"))).toEqual({ route: "game", section: "snake" });
    expect(parseLocation(playPath("snake", "mid"))).toEqual({ route: "play", section: "snake", detail: "mid" });
  });
});

describe("navRoutesFor", () => {
  it("keeps game-scoped pages out of the platform navigation", () => {
    expect(navRoutesFor("platform").map((entry) => entry.route)).toEqual(["home", "about"]);
  });

  it("shows levels, rules and the API only inside a game", () => {
    expect(navRoutesFor("game").map((entry) => entry.route)).toEqual(["game", "rules", "docs"]);
  });

  it("never lists the arena itself", () => {
    const listed = [...navRoutesFor("platform"), ...navRoutesFor("game")];
    expect(listed.map((entry) => entry.route)).not.toContain("play");
  });
});

import { describe, expect, it } from "vitest";
import { buildServers } from "../games/regions";
import type { Level, Region } from "../games/types";
import { renderRegionPicker } from "./regionPicker";

const regions: Region[] = [
  { key: "us-east", label: "US East", location: "New York" },
  { key: "eu-west", label: "Europe", location: "London" },
];

function game(origins: Record<string, string>): { levels: Level[] } {
  return {
    levels: [{ key: "paper", label: "Paper", stakeNanos: 1, money: "Paper", blurb: "", availability: "open", servers: buildServers(regions, origins) }],
  };
}

describe("renderRegionPicker", () => {
  it("offers Auto plus every deployed region", () => {
    const html = renderRegionPicker(game({ "us-east": "https://us.example.com", "eu-west": "https://eu.example.com" }));
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="us-east"');
    expect(html).toContain("Europe");
    expect(html).toContain("London");
  });

  it("stays out of the way with a single region or no regional deployment", () => {
    expect(renderRegionPicker(game({ "us-east": "https://us.example.com" }))).toBe("");
    expect(renderRegionPicker(game({}))).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import {
  AUTO_REGION,
  buildServers,
  chooseServer,
  endpointUrl,
  gameRegions,
  LOCAL_REGION,
  loadRegionPreference,
  measureLatency,
  normalizeOrigin,
  pingTargets,
  saveRegionPreference,
} from "./regions";
import type { Level, Region } from "./types";

const usEast: Region = { key: "us-east", label: "US East", location: "New York" };
const euWest: Region = { key: "eu-west", label: "Europe", location: "London" };
const apac: Region = { key: "ap-southeast", label: "Asia-Pacific", location: "Singapore" };
const regions = [usEast, euWest, apac];

function level(key: string, servers: Level["servers"], availability: Level["availability"] = "open"): Level {
  return { key, label: key, stakeNanos: 1, money: "Paper", blurb: "", availability, servers };
}

describe("buildServers", () => {
  it("keeps deployed regions in region order and drops empty ones", () => {
    const servers = buildServers(regions, { "eu-west": "https://eu.example.com/", "us-east": "https://us.example.com", "ap-southeast": "" });
    expect(servers).toEqual([
      { region: usEast, origin: "https://us.example.com" },
      { region: euWest, origin: "https://eu.example.com" },
    ]);
  });

  it("falls back to the site's own origin when nothing is deployed", () => {
    expect(buildServers(regions, {})).toEqual([{ region: LOCAL_REGION, origin: "" }]);
  });

  it("rejects values that are not bare origins", () => {
    expect(() => normalizeOrigin("https://eu.example.com/ws")).toThrow();
    expect(() => normalizeOrigin("ftp://eu.example.com")).toThrow();
    expect(normalizeOrigin("http://127.0.0.1:3002")).toBe("http://127.0.0.1:3002");
  });
});

describe("endpointUrl", () => {
  const page = { protocol: "https:", host: "play.example.com" };

  it("resolves an empty origin against the page, for the dev proxy and single-server setups", () => {
    expect(endpointUrl("", "/config", "http", page)).toBe("https://play.example.com/config");
    expect(endpointUrl("", "/ws", "ws", page)).toBe("wss://play.example.com/ws");
    expect(endpointUrl("", "/ws", "ws", { protocol: "http:", host: "127.0.0.1:5173" })).toBe("ws://127.0.0.1:5173/ws");
  });

  it("targets another region's host with the matching socket scheme", () => {
    expect(endpointUrl("https://eu.example.com", "/ws", "ws", page)).toBe("wss://eu.example.com/ws");
    expect(endpointUrl("http://127.0.0.1:3002", "/bot", "ws", page)).toBe("ws://127.0.0.1:3002/bot");
    expect(endpointUrl("https://eu.example.com", "/health", "http", page)).toBe("https://eu.example.com/health");
  });
});

describe("chooseServer", () => {
  const paper = level("paper", buildServers(regions, { "us-east": "https://us", "eu-west": "https://eu", "ap-southeast": "https://ap" }));

  it("honours an explicit region the level runs in", () => {
    expect(chooseServer(paper, "eu-west", new Map([["us-east", 5]]))?.region).toBe(euWest);
  });

  it("picks the lowest ping on auto, or for a region the level does not run in", () => {
    const latencies = new Map([["us-east", 90], ["eu-west", 20], ["ap-southeast", 200]]);
    expect(chooseServer(paper, AUTO_REGION, latencies)?.region).toBe(euWest);
    expect(chooseServer(paper, "mars", latencies)?.region).toBe(euWest);
  });

  it("ignores unreachable regions and falls back to the first without measurements", () => {
    expect(chooseServer(paper, AUTO_REGION, new Map([["ap-southeast", 150]]))?.region).toBe(apac);
    expect(chooseServer(paper, AUTO_REGION, new Map())?.region).toBe(usEast);
  });
});

describe("gameRegions and pingTargets", () => {
  it("lists each open region once and skips locked levels and same-origin servers", () => {
    const game = {
      levels: [
        level("paper", buildServers(regions, { "us-east": "https://us-paper", "eu-west": "https://eu-paper" })),
        level("casual", buildServers(regions, { "ap-southeast": "https://ap-casual" }), "comingSoon"),
        level("mid", buildServers(regions, { "eu-west": "https://eu-mid" })),
      ],
    };
    expect(gameRegions(game)).toEqual([usEast, euWest]);
    expect(pingTargets(game).map((server) => server.origin)).toEqual(["https://us-paper", "https://eu-paper"]);
    expect(pingTargets({ levels: [level("paper", buildServers(regions))] })).toEqual([]);
  });
});

describe("measureLatency", () => {
  it("reports the fastest of several round trips, rounded", async () => {
    const durations = [180, 42.4, 47];
    let clock = 0;
    let call = 0;
    const fetchImpl = (async () => {
      clock += durations[call++]!;
      return new Response("ok");
    }) as typeof fetch;
    const now = () => clock;
    await expect(measureLatency("https://eu", { fetchImpl, now })).resolves.toBe(42);
    expect(call).toBe(3);
  });

  it("is undefined when the server cannot be reached or is unhealthy", async () => {
    const failing = (async () => {
      throw new TypeError("network");
    }) as typeof fetch;
    await expect(measureLatency("https://down", { fetchImpl: failing })).resolves.toBeUndefined();
    const unhealthy = (async () => new Response("no", { status: 503 })) as typeof fetch;
    await expect(measureLatency("https://sick", { fetchImpl: unhealthy })).resolves.toBeUndefined();
  });
});

describe("region preference", () => {
  it("keeps the choice for this visit even without browser storage", () => {
    expect(loadRegionPreference("test-game")).toBe(AUTO_REGION);
    saveRegionPreference("test-game", "eu-west");
    expect(loadRegionPreference("test-game")).toBe("eu-west");
    saveRegionPreference("test-game", AUTO_REGION);
    expect(loadRegionPreference("test-game")).toBe(AUTO_REGION);
  });
});

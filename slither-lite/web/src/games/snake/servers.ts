import { buildServers } from "../regions";
import type { LevelServer, Region } from "../types";

/**
 * Where QuantArena runs. This is the only file to edit when you deploy or add a region.
 *
 * Every (level, region) pair is its own server process with its own arena, floor money and
 * leaderboard. Give each one a public origin below; leave a region empty ("") until that
 * server exists, and it simply will not be offered. A level with no origins at all falls back
 * to the site's own origin, which is what `npm run dev` and a single-server setup use.
 *
 * Each server must be started with `SLITHER_REGION` set to the matching key below and
 * `SLITHER_TIER` set to the level key, and with `SLITHER_ALLOWED_ORIGINS` listing the origin
 * the site itself is served from (see "Deploying regions" in the README).
 */
export const snakeRegions = [
  { key: "us-east", label: "US East", location: "New York" },
  { key: "eu-west", label: "Europe", location: "London" },
  { key: "ap-southeast", label: "Asia-Pacific", location: "Singapore" },
] as const satisfies readonly Region[];

export type SnakeRegionKey = (typeof snakeRegions)[number]["key"];

type LevelOrigins = Partial<Record<SnakeRegionKey, string>>;

const deployedOrigins: Record<string, LevelOrigins> = {
  paper: {
    "us-east": "", // e.g. "https://us-east.quantarena.example"
    "eu-west": "", // e.g. "https://eu-west.quantarena.example"
    "ap-southeast": "", // e.g. "https://ap-southeast.quantarena.example"
  },
  // Real-money tiers are not open yet. When one is, give it its own servers, e.g.
  // casual: { "us-east": "https://us-east-casual.quantarena.example" },
};

/**
 * Optional build-time override with the same shape as `deployedOrigins`, e.g.
 * `VITE_SNAKE_ORIGINS='{"paper":{"us-east":"http://127.0.0.1:3001","eu-west":"http://127.0.0.1:3002"}}'`
 * for trying two regions on one machine, or for keeping hostnames in CI instead of in code.
 */
function originOverrides(): Record<string, LevelOrigins> {
  const raw = import.meta.env.VITE_SNAKE_ORIGINS;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, LevelOrigins>;
  } catch {
    throw new Error("VITE_SNAKE_ORIGINS must be JSON such as {\"paper\":{\"us-east\":\"https://…\"}}");
  }
}

const overrides = originOverrides();

export function snakeServers(levelKey: string): LevelServer[] {
  return buildServers(snakeRegions, { ...deployedOrigins[levelKey], ...overrides[levelKey] });
}

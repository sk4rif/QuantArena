import type { GameModule, Level, LevelServer, Region } from "./types";

/** Region of the fallback server: the site's own origin, used when a level has no regional deployments. */
export const LOCAL_REGION: Region = { key: "local", label: "This server", location: "" };

/** Preference value meaning "pick the region with the lowest ping". */
export const AUTO_REGION = "auto";

/**
 * Builds a level's server list from region → origin entries, in region order. Regions without
 * an origin are not deployed and are left out. With nothing deployed the level runs on the
 * site's own origin, which is how local development and single-server setups work.
 */
export function buildServers(regions: readonly Region[], origins: Readonly<Record<string, string | undefined>> = {}): LevelServer[] {
  const servers = regions.flatMap((region) => {
    const origin = normalizeOrigin(origins[region.key] ?? "");
    return origin ? [{ region, origin }] : [];
  });
  return servers.length > 0 ? servers : [{ region: LOCAL_REGION, origin: "" }];
}

/** `https://eu.example.com/` → `https://eu.example.com`; rejects anything that is not a bare http(s) origin. */
export function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const url = new URL(trimmed);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname.replace(/\/$/, "") || url.search || url.hash) {
    throw new Error(`Server origin must look like https://host[:port], got ${value}`);
  }
  return url.origin;
}

/** Absolute URL of an arena endpoint. An empty origin resolves against the page, so the Vite dev proxy keeps working. */
export function endpointUrl(origin: string, path: string, kind: "http" | "ws" = "http", page?: Pick<Location, "protocol" | "host">): string {
  const pageOrigin = (): string => {
    const current = page ?? location;
    return `${current.protocol}//${current.host}`;
  };
  const base = origin || pageOrigin();
  const url = new URL(path, base);
  if (kind === "ws") url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Distinct regions a game can be played in, in the order its open levels list them. */
export function gameRegions(game: Pick<GameModule, "levels">): Region[] {
  const regions = new Map<string, Region>();
  for (const level of game.levels) {
    if (level.availability !== "open") continue;
    for (const server of level.servers) if (!regions.has(server.region.key)) regions.set(server.region.key, server.region);
  }
  return [...regions.values()];
}

/** One server per region for measuring ping. Latency depends on the host, not the level, so any open level's server will do. */
export function pingTargets(game: Pick<GameModule, "levels">): LevelServer[] {
  const targets = new Map<string, LevelServer>();
  for (const level of game.levels) {
    if (level.availability !== "open") continue;
    for (const server of level.servers) {
      if (server.origin && !targets.has(server.region.key)) targets.set(server.region.key, server);
    }
  }
  return [...targets.values()];
}

/**
 * Picks the arena for a level. An explicit region is honoured when the level runs there;
 * otherwise the region with the lowest measured ping wins, and without measurements the first.
 */
export function chooseServer(level: Pick<Level, "servers">, preference: string | undefined, latencies: ReadonlyMap<string, number>): LevelServer | undefined {
  const preferred = preference && preference !== AUTO_REGION
    ? level.servers.find((server) => server.region.key === preference)
    : undefined;
  if (preferred) return preferred;
  let best: LevelServer | undefined;
  for (const server of level.servers) {
    const latency = latencies.get(server.region.key);
    if (latency === undefined) continue;
    if (!best || latency < latencies.get(best.region.key)!) best = server;
  }
  return best ?? level.servers[0];
}

/**
 * Round-trip time to an arena's `/health`, in milliseconds: the fastest of a few sequential
 * requests, so the first request's DNS and TLS setup does not count. Undefined when unreachable.
 */
export async function measureLatency(
  origin: string,
  { attempts = 3, timeoutMs = 2_000, fetchImpl = fetch, now = () => performance.now() }: {
    attempts?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<number | undefined> {
  let best: number | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const startedAt = now();
      const response = await fetchImpl(endpointUrl(origin, "/health"), { cache: "no-store", signal: controller.signal });
      if (!response.ok) continue;
      await response.text();
      const elapsed = now() - startedAt;
      best = best === undefined ? elapsed : Math.min(best, elapsed);
    } catch {
      // Unreachable, blocked or timed out: try the remaining attempts, then report what we have.
    } finally {
      clearTimeout(timer);
    }
  }
  return best === undefined ? undefined : Math.round(best);
}

/** Latest ping per region key, shared by the region picker and server selection. */
export const regionLatencies = new Map<string, number>();
const pendingPings = new Map<string, Promise<void>>();

/** Measures every region of a game in parallel, at most once per region per page load unless `refresh` is set. */
export function pingRegions(game: Pick<GameModule, "levels">, onResult?: (regionKey: string, latency: number | undefined) => void, refresh = false): Promise<void> {
  const jobs = pingTargets(game).map((server) => {
    const key = server.region.key;
    let job = refresh ? undefined : pendingPings.get(key);
    if (!job) {
      job = measureLatency(server.origin).then((latency) => {
        if (latency === undefined) regionLatencies.delete(key);
        else regionLatencies.set(key, latency);
      });
      pendingPings.set(key, job);
    }
    return job.then(() => onResult?.(key, regionLatencies.get(key)));
  });
  return Promise.all(jobs).then(() => undefined);
}

/**
 * Resolves the arena for a level. With an automatic choice across several regions it waits
 * for the ping measurements, but never longer than `waitMs`, then falls back to what it has.
 */
export async function resolveServer(game: Pick<GameModule, "id" | "levels">, level: Pick<Level, "servers">, explicitRegion?: string, waitMs = 2_500): Promise<LevelServer | undefined> {
  const preference = explicitRegion || loadRegionPreference(game.id);
  const automatic = !level.servers.some((server) => server.region.key === preference);
  if (automatic && level.servers.length > 1) {
    await Promise.race([pingRegions(game), new Promise((resolve) => setTimeout(resolve, waitMs))]);
  }
  return chooseServer(level, preference, regionLatencies);
}

function preferenceKey(gameId: string): string {
  return `zero-sum:region:${gameId}`;
}

/** This visit's choices; the source of truth when browser storage is blocked (private mode, sandboxed frames). */
const sessionPreferences = new Map<string, string>();

/** The region the player picked for a game, or `auto`. */
export function loadRegionPreference(gameId: string): string {
  const chosen = sessionPreferences.get(gameId);
  if (chosen) return chosen;
  try {
    return localStorage.getItem(preferenceKey(gameId)) || AUTO_REGION;
  } catch {
    return AUTO_REGION;
  }
}

export function saveRegionPreference(gameId: string, regionKey: string): void {
  sessionPreferences.set(gameId, regionKey);
  try {
    if (regionKey === AUTO_REGION) localStorage.removeItem(preferenceKey(gameId));
    else localStorage.setItem(preferenceKey(gameId), regionKey);
  } catch {
    // Still applies for this visit through `sessionPreferences`; it just is not remembered.
  }
}

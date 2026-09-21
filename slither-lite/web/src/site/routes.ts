export type Route = "home" | "about" | "game" | "play" | "rules" | "docs";

/**
 * Which header navigation a link belongs to. `platform` links are always relevant;
 * `game` links only make sense once a game has been chosen, because rules, levels and the
 * API are per-game.
 */
export type NavScope = "platform" | "game";

export interface RouteEntry {
  route: Route;
  path: string;
  label: string;
  /** The navigation this route is listed in, or `undefined` to keep it out of the header. */
  nav?: NavScope;
}

export const routes: readonly RouteEntry[] = [
  { route: "home", path: "#/", label: "Games", nav: "platform" },
  { route: "about", path: "#/about", label: "About", nav: "platform" },
  { route: "game", path: "#/game/snake", label: "Levels", nav: "game" },
  { route: "play", path: "#/play", label: "Play" },
  { route: "rules", path: "#/rules", label: "Rules", nav: "game" },
  { route: "docs", path: "#/docs", label: "API Docs", nav: "game" },
];

export function navRoutesFor(scope: NavScope): readonly RouteEntry[] {
  return routes.filter((entry) => entry.nav === scope);
}

export const defaultRoute: Route = "home";

export interface Location {
  route: Route;
  /**
   * Second path segment. A page anchor on the content pages (`errors` for `#/docs/errors`,
   * element id `docs-errors`), or a game id on `#/game/snake` and `#/play/snake/paper`.
   */
  section?: string;
  /** Third path segment, used for the level key in `#/play/snake/paper`. */
  detail?: string;
}

/** Parses a hash such as `#/docs`, `#/docs/errors` or `#/play/snake/paper`; unknown hashes fall back to the default route. */
export function parseLocation(hash: string): Location {
  const [head = "", section, detail] = hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
  const route = routes.find((entry) => entry.route === head)?.route;
  if (!route) return { route: defaultRoute };
  return { route, ...(section ? { section } : {}), ...(section && detail ? { detail } : {}) };
}

export function parseRoute(hash: string): Route {
  return parseLocation(hash).route;
}

/** Hash for a game's level-select page. */
export function gamePath(gameId: string): string {
  return `#/game/${gameId}`;
}

/** Hash that enters a specific level of a game. */
export function playPath(gameId: string, levelKey: string): string {
  return `#/play/${gameId}/${levelKey}`;
}

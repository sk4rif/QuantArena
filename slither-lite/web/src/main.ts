import "./styles.css";
import "./site.css";
import { isLive, leaveArena, refreshLobby, startArena } from "./arena";
import { auth } from "./auth";
import { mountAuth } from "./auth/ui";
import { findGame, findLevel, games, type Game, type Level } from "./site/catalog";
import { renderAbout } from "./site/pages/about";
import { bindDocs, renderDocs } from "./site/pages/docs";
import { renderHome } from "./site/pages/home";
import { renderLevels } from "./site/pages/levels";
import { hydrateRules, renderRules } from "./site/pages/rules";
import { gamePath, navRoutesFor, parseLocation, playPath, type NavScope, type Route } from "./site/routes";
import { escapeHtml, requiredElement } from "./util/html";

const views: Record<Route, HTMLElement> = {
  home: requiredElement("#view-home"),
  about: requiredElement("#view-about"),
  game: requiredElement("#view-game"),
  play: requiredElement("#view-play"),
  rules: requiredElement("#view-rules"),
  docs: requiredElement("#view-docs"),
};
/** Rules, levels and the API are per-game, so those links only appear once a game is chosen. */
const navScopes: Record<Route, NavScope> = {
  home: "platform",
  about: "platform",
  game: "game",
  play: "game",
  rules: "game",
  docs: "game",
};
/** Which header link is highlighted; the arena highlights the level-select link it came from. */
const navHighlight: Record<Route, Route> = {
  home: "home",
  about: "about",
  game: "game",
  play: "game",
  rules: "rules",
  docs: "docs",
};
const rendered = new Set<Route>();
let current: Route | undefined;
/** Game whose level-select page is currently rendered, so it re-renders when the id changes. */
let renderedGame: string | undefined;
/** The game and level being played, set before the arena route is shown. */
let active: { game: Game; level: Level } | undefined;

const accountUi = mountAuth(auth, requiredElement("#account"), requiredElement<HTMLDialogElement>("#auth-dialog"));
auth.subscribe(() => refreshLobby());

const siteNav = requiredElement("#site-nav");
const paperBadge = requiredElement<HTMLElement>("#paper-badge");

document.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>(".copy");
  const text = button?.parentElement?.querySelector("code")?.textContent;
  if (!button || !text) return;
  void navigator.clipboard?.writeText(text).then(() => {
    button.textContent = "Copied";
    window.setTimeout(() => (button.textContent = "Copy"), 1500);
  });
});

window.addEventListener("hashchange", navigate);
navigate();

function navigate(): void {
  const { route, section, detail } = parseLocation(location.hash);

  // The arena is only reachable through a concrete, open level.
  if (route === "play") {
    const game = findGame(section);
    const level = game ? findLevel(game, detail) : undefined;
    if (!game || !level || level.availability !== "open") {
      location.hash = game ? gamePath(game.id) : "#/";
      return;
    }
    active = { game, level };
  }

  if (current === "play" && route !== "play" && isLive()) {
    if (!window.confirm("Leave the arena? Your snake will be cashed out automatically.")) {
      if (active) history.replaceState(null, "", playPath(active.game.id, active.level.key));
      return;
    }
  }
  if (current === "play" && route !== "play") leaveArena();

  if (route === "game" && (!rendered.has("game") || section !== renderedGame)) renderGame(section);
  if (route !== current) show(route);
  document.title = title(route);
  if (route !== "play") scrollToSection(route, route === "game" ? undefined : section);
}

function show(route: Route): void {
  for (const [name, view] of Object.entries(views)) view.hidden = name !== route;
  if (!rendered.has(route)) render(route);
  renderNav(route);
  current = route;
}

/** Rebuilds the header for the route's scope, so game links appear only inside a game. */
function renderNav(route: Route): void {
  const scope = navScopes[route];
  const highlight = navHighlight[route];
  siteNav.innerHTML = navRoutesFor(scope)
    .map((entry) => {
      const path = entry.route === "game" ? gamePath(currentGameId()) : entry.path;
      const currentAttribute = entry.route === highlight ? ' aria-current="page"' : "";
      return `<a href="${path}"${currentAttribute}>${escapeHtml(entry.label)}</a>`;
    })
    .join("");
  paperBadge.hidden = scope !== "game";
}

function currentGameId(): string {
  return active?.game.id ?? renderedGame ?? games[0]!.id;
}

function render(route: Route): void {
  const view = views[route];
  if (route === "home") {
    view.innerHTML = renderHome();
  } else if (route === "about") {
    view.innerHTML = renderAbout();
  } else if (route === "rules") {
    view.innerHTML = renderRules();
    void hydrateRules(view);
  } else if (route === "docs") {
    view.innerHTML = renderDocs();
    bindDocs(view);
  } else if (route === "play") {
    startArena({
      defaultName: () => auth.user?.displayName ?? "Player",
      signedIn: () => auth.user !== null,
      requestSignIn: () => accountUi.open("signIn"),
      level: () => active?.level,
      changeLevel: () => (location.hash = gamePath(active?.game.id ?? "snake")),
    });
  }
  rendered.add(route);
}

function renderGame(gameId: string | undefined): void {
  views.game.innerHTML = renderLevels(gameId);
  renderedGame = gameId;
  rendered.add("game");
}

function title(route: Route): string {
  if (route === "game") {
    const game = findGame(renderedGame);
    return game ? `${game.name} levels · Skillz` : "Skillz";
  }
  if (route === "play" && active) return `${active.level.label} · ${active.game.name} · Skillz`;
  if (route === "about") return "About · Skillz";
  if (route === "rules") return "Rules · Skillz";
  if (route === "docs") return "API Docs · Skillz";
  return "Games · Skillz";
}

function scrollToSection(route: Route, section?: string): void {
  const target = section ? document.getElementById(`${route}-${section}`) : null;
  if (target) target.scrollIntoView({ block: "start" });
  else views[route].scrollTo({ top: 0 });
}

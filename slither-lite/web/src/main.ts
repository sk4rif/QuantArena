import "./site.css";
import { auth } from "./auth";
import { mountAuth } from "./auth/ui";
import { findGame, findLevel, games, type GameModule, type Level } from "./games";
import { renderAbout } from "./site/pages/about";
import { renderHome } from "./site/pages/home";
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
let pendingNavigation = false;
/** Game whose level-select page is currently rendered, so it re-renders when the id changes. */
let renderedGame: string | undefined;
/** The game and level being played, set before the arena route is shown. */
let active: { game: GameModule; level: Level } | undefined;

const accountUi = mountAuth(auth, requiredElement("#account"), requiredElement<HTMLDialogElement>("#auth-dialog"));
auth.subscribe(() => active?.game.runtime.refreshLobby());

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
window.addEventListener("beforeunload", (event) => {
  if (!active?.game.runtime.isLive()) return;
  event.preventDefault();
  event.returnValue = "";
});
navigate();

function navigate(): void {
  const targetHash = location.hash;
  const { route, section, detail } = parseLocation(targetHash);

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

  if (current === "play" && route !== "play" && active?.game.runtime.isLive()) {
    history.replaceState(null, "", playPath(active.game.id, active.level.key));
    if (!pendingNavigation) {
      pendingNavigation = true;
      const confirmation = active.game.leaveConfirmation;
      void active.game.runtime
        .confirmAction(confirmation.title, confirmation.message, confirmation.acceptLabel)
        .then((confirmed) => {
          pendingNavigation = false;
          if (!confirmed) return;
          active?.game.runtime.leave();
          location.hash = targetHash;
        });
    }
    return;
  }
  if (current === "play" && route !== "play") active?.game.runtime.leave();

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

function currentGame(): GameModule {
  return findGame(renderedGame) ?? active?.game ?? games[0]!;
}

function currentGameId(): string {
  return currentGame().id;
}

function render(route: Route): void {
  const view = views[route];
  if (route === "home") {
    view.innerHTML = renderHome();
  } else if (route === "about") {
    view.innerHTML = renderAbout();
  } else if (route === "rules") {
    const game = currentGame();
    view.innerHTML = game.renderRules();
    void game.hydrateRules(view);
  } else if (route === "docs") {
    const game = currentGame();
    view.innerHTML = game.renderDocs();
    game.bindDocs(view);
  } else if (route === "play" && active) {
    active.game.runtime.start({
      accountName: () => auth.user?.displayName,
      signedIn: () => auth.user !== null,
      requestSignIn: () => accountUi.open("signIn"),
      level: () => active?.level,
      changeLevel: () => (location.hash = gamePath(active?.game.id ?? games[0]!.id)),
    });
  }
  rendered.add(route);
}

function renderGame(gameId: string | undefined): void {
  const game = findGame(gameId);
  views.game.innerHTML = game ? game.renderLevels(gameId) : renderMissingGame();
  if (renderedGame !== gameId) {
    rendered.delete("rules");
    rendered.delete("docs");
  }
  renderedGame = gameId;
  rendered.add("game");
}

function renderMissingGame(): string {
  return `
    <article class="doc">
      <header class="doc-hero">
        <h1>Game not found</h1>
        <p class="lead">No game matches this address. <a href="#/">Back to the game list</a>.</p>
      </header>
    </article>`;
}

function title(route: Route): string {
  if (route === "game") {
    const game = findGame(renderedGame);
    return game ? `${game.name} levels · Zero Sum` : "Zero Sum";
  }
  if (route === "play" && active) return `${active.level.label} · ${active.game.name} · Zero Sum`;
  if (route === "about") return "About · Zero Sum";
  if (route === "rules") return "Rules · Zero Sum";
  if (route === "docs") return "API Docs · Zero Sum";
  return "Games · Zero Sum";
}

function scrollToSection(route: Route, section?: string): void {
  const target = section ? document.getElementById(`${route}-${section}`) : null;
  if (target) target.scrollIntoView({ block: "start" });
  else views[route].scrollTo({ top: 0 });
}

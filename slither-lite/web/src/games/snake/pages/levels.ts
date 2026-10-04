import { escapeHtml } from "../../../util/html";
import { playPath } from "../../../site/routes";
import { isFree, stakeLabel, type GameModule, type Level } from "../../types";
import { snakeGame } from "..";

/** Level-select page for one game. Unknown game ids render a short not-found notice. */
export function renderLevels(gameId: string | undefined): string {
  const game = gameId === snakeGame.id ? snakeGame : undefined;
  if (!game) {
    return `
    <article class="doc">
      <header class="doc-hero">
        <h1>Game not found</h1>
        <p class="lead">No game matches this address. <a href="#/">Back to the game list</a>.</p>
      </header>
    </article>`;
  }

  return `
  <article class="doc">
    <header class="doc-hero">
      <a class="back-link" href="#/">All games</a>
      <h1>${escapeHtml(game.name)}</h1>
      <p class="lead">${escapeHtml(game.tagline)}. Choose the level you want to play.</p>
      <p class="hint">Levels share the rules and the API and differ only by the stake. Each one runs on its own server, so your worth, the leaderboard and the floor cash are separate per level.</p>
    </header>

    <section id="levels-list">
      <h2>Levels</h2>
      <div class="level-grid">${game.levels.map((level) => levelCard(game, level)).join("")}</div>
    </section>

    <section id="levels-before">
      <h2>Before you enter</h2>
      <p>Entering a level costs one ticket, and your snake starts with a worth equal to that ticket. Read the <a href="#/rules">rules</a> for the cost formulas, elimination and cash-out, or the <a href="#/docs">API docs</a> to drive a snake with a bot.</p>
    </section>
  </article>`;
}

function levelCard(game: GameModule, level: Level): string {
  const open = level.availability === "open";
  const free = isFree(level);
  const action = open
    ? `<a class="btn btn-primary btn-block" href="${playPath(game.id, level.key)}">${free ? "Play" : `Enter for ${stakeLabel(level)}`}</a>`
    : `<button class="btn btn-block" type="button" disabled>Coming soon</button>`;
  return `
    <div class="card card-level${open ? "" : " is-locked"}">
      <div class="card-head">
        <h3>${escapeHtml(level.label)}</h3>
        <span class="tag ${open ? "tag-open" : ""}">${escapeHtml(level.money)}</span>
      </div>
      <p class="level-stake">${stakeLabel(level)}<span>${free ? "to enter" : "ticket"}</span></p>
      <p>${escapeHtml(level.blurb)}</p>
      ${action}
    </div>`;
}

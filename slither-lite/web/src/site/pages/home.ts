import { escapeHtml } from "../../util/html";
import { formatMoney } from "../../net/protocol";
import { games, isFree, type Game } from "../catalog";
import { gamePath } from "../routes";

export function renderHome(): string {
  return `
  <article class="doc">
    <header class="doc-hero">
      <h1>Games</h1>
    </header>

    <section id="home-games">
      <div class="card-grid">
        ${games.map(gameCard).join("")}
        <div class="card card-game card-empty">
          <div class="card-media"><span class="card-thumb"></span></div>
          <div class="card-body">
            <h3>More games</h3>
            <p>Further skill games will appear here as they are built.</p>
          </div>
        </div>
      </div>
      <p class="hint">Every level currently open uses a simulated ledger. No real funds are accepted, held, or paid.</p>
    </section>
  </article>`;
}

function gameCard(game: Game): string {
  const range = stakeRange(game);
  const open = game.availability === "open";
  // The card is a single link, so the call to action is a span rather than a nested anchor.
  return `
    <a class="card card-game" href="${gamePath(game.id)}"${open ? "" : ' aria-disabled="true"'}>
      <div class="card-media">
        <span class="card-thumb">${game.icon}</span>
        ${open ? "" : '<span class="tag card-tag">Coming soon</span>'}
      </div>
      <div class="card-body">
        <h3>${escapeHtml(game.name)}</h3>
        <p>${escapeHtml(game.description)}</p>
        <p class="card-meta">${game.levels.length} levels · ${range}</p>
        <span class="card-play">Play</span>
      </div>
    </a>`;
}

/** Summarises what a game costs, treating paper levels as free rather than as their simulated ticket. */
function stakeRange(game: Game): string {
  const paid = game.levels.filter((level) => !isFree(level)).map((level) => level.stakeNanos);
  const free = game.levels.some(isFree);
  if (!paid.length) return free ? "Free" : "–";
  const low = free ? "Free" : formatMoney(Math.min(...paid));
  const high = formatMoney(Math.max(...paid));
  return low === high ? high : `${low} – ${high}`;
}

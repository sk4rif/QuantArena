import { escapeHtml } from "../../util/html";
import { formatMoney, games, isFree, type GameModule } from "../../games";
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

function gameCard(game: GameModule): string {
  const range = stakeRange(game);
  const open = game.availability === "open";
  // The card uses separate links so its supporting material is reachable without entering the level selector.
  return `
    <article class="card card-game">
      <a class="card-media" href="${gamePath(game.id)}" aria-label="View ${escapeHtml(game.name)} levels"${open ? "" : ' aria-disabled="true"'}>
        <span class="card-thumb">${game.icon}</span>
        ${open ? "" : '<span class="tag card-tag">Coming soon</span>'}
      </a>
      <div class="card-body">
        <h3>${escapeHtml(game.name)}</h3>
        <p>${escapeHtml(game.description)}</p>
        <p class="card-meta">${game.levels.length} levels · ${range}</p>
        <div class="card-actions">
          <a class="card-secondary" href="#/rules">Rules</a>
          <a class="card-secondary" href="#/docs">API Docs</a>
          <a class="card-play" href="${gamePath(game.id)}"${open ? "" : ' aria-disabled="true"'}>Play</a>
        </div>
      </div>
    </article>`;
}

/** Summarises what a game costs, treating paper levels as free rather than as their simulated ticket. */
function stakeRange(game: GameModule): string {
  const paid = game.levels.filter((level) => !isFree(level)).map((level) => level.stakeNanos);
  const free = game.levels.some(isFree);
  if (!paid.length) return free ? "Free" : "–";
  const low = free ? "Free" : formatMoney(Math.min(...paid));
  const high = formatMoney(Math.max(...paid));
  return low === high ? high : `${low} – ${high}`;
}

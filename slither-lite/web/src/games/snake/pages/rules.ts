import { escapeHtml } from "../../../util/html";
import { isFree } from "../../types";
import { snakeGame } from "..";
import { formatMoney } from "../net/protocol";

export function renderRules(): string {
  // Derived from the game module so the table cannot drift from the level-select page.
  const tiers = snakeGame.levels.map((level) => ({
    label: level.label,
    // A paper level costs nothing, but its simulated ticket still drives worth and geometry.
    ticket: isFree(level) ? `Free (${formatMoney(level.stakeNanos)} simulated)` : formatMoney(level.stakeNanos),
    money: level.money,
    status: level.availability === "open" ? "Open" : "Not open yet",
  }));
  return `
  <article class="doc">
    <header class="doc-hero">
      <span class="pill">Paper money · no real funds</span>
      <h1>QuantArena rules</h1>
      <p class="lead">QuantArena is a multiplayer arena. Each player controls a snake that holds a sum of money, its <strong>worth</strong>. This page describes how the system works: what things cost, what happens on each event, and where money goes.</p>
      <p class="live-line" id="rules-live"></p>
    </header>

    <nav class="doc-toc" aria-label="On this page">
      <a href="#/rules/entry">Levels and entry</a><a href="#/rules/controls">Controls</a><a href="#/rules/worth">Worth and growth</a><a href="#/rules/costs">Costs</a>
      <a href="#/rules/death">Elimination</a><a href="#/rules/cashout">Cash-out</a><a href="#/rules/placement">Money placement</a><a href="#/rules/ledger">Ledger</a><a href="#/rules/system">System</a>
    </nav>

    <section id="rules-entry">
      <h2>Levels and entry</h2>
      <p>QuantArena runs in levels, and each server runs exactly one tier. <strong>PaperArena</strong> is the Paper-tier level: it uses paper money, transfers no real funds, and uses the same rules and API as every other tier. It exists for practice and for training bots. Pick a level on the <a href="#/game/snake">levels page</a>.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Tier</th><th>Ticket</th><th>Money</th><th>Status</th></tr></thead>
        <tbody>${tiers.map((tier) => `<tr><td>${tier.label}</td><td>${tier.ticket}</td><td>${tier.money || "&ndash;"}</td><td>${tier.status}</td></tr>`).join("")}</tbody>
      </table></div>
      <p>Entering costs one <strong>ticket</strong>, and the snake starts with a worth equal to that ticket. Re-entering after an elimination or a cash-out records a new ticket. New snakes are protected from collisions for 2 seconds. Spectating is free: it creates no snake, records no ticket, and lets you watch the live arena before entering.</p>
      <p>When a server starts, its arena holds a treasury of 20 tickets, laid out as $0.50 balls (see <a href="#/rules/placement">Money placement</a>).</p>
    </section>

    <section id="rules-controls">
      <h2>Controls</h2>
      <p>A player sends steering, boost on/off, and cash-out start or cancellation inputs. The browser client derives the direction from the pointer and boost from the mouse buttons or <kbd>Space</kbd>. Press <kbd>C</kbd> to start cash-out and <kbd>X</kbd> to cancel its countdown. Bots send the same inputs through the <a href="#/docs">API</a>.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Arena</td><td>6,000 × 6,000 square; crossing an edge wraps to the opposite edge</td></tr>
          <tr><td>Simulation rate</td><td>30 ticks per second</td></tr>
          <tr><td>Speed</td><td>150 units/s, or 220 units/s while boosting</td></tr>
          <tr><td>Turn rate</td><td>Up to 3.4 rad/s toward the requested direction</td></tr>
        </tbody>
      </table></div>
    </section>

    <section id="rules-worth">
      <h2>Worth and growth</h2>
      <p>Money is counted in nano-dollars ($1 = 1,000,000,000) with exact integer arithmetic, so rounding neither creates nor destroys money. There is a single ball denomination: every ball is worth <strong>$0.50</strong>. Collecting a ball adds its value to the snake's worth.</p>
      <p>A snake's size is derived from its worth relative to the tier's ticket:</p>
      <pre class="formula">radius      = clamp(12 × √(worth / ticket), 10, 48)
body points = clamp(round(24 × worth / ticket), 8, 1200)</pre>
      <p>Doubling the worth increases the radius by about 41% and doubles the number of body points. Collision size uses this radius.</p>
    </section>

    <section id="rules-costs">
      <h2>Costs</h2>
      <p>Two charges apply on every simulation tick, both computed from the worth at the start of the tick:</p>
      <pre class="formula">effective_worth = max(worth, $5)
starvation_tax  = effective_worth × 5 / 100,000              every tick
boost_cost      = effective_worth × 2,667 / 2,000,000        only while boosting</pre>
      <p>Charges are integer nano-dollar amounts. The fractional remainder is carried to the next tick, so nothing is lost to rounding. Both charges are taken out of the snake's worth and added to the server's <em>pending floor pool</em>.</p>
      <p>At a worth of $5 or less, the starvation tax is $0.00025 per tick ($0.0075 per second) and the boost cost is $0.0066675 per tick ($0.20 per second). Boost cost also accumulates in a separate reserve; each time that reserve reaches $0.50, one $0.50 ball is created at the position of a boosting snake. On any tick in which no snake is boosting, the reserve is cleared and its money is released with the rest of the pending floor pool. A snake whose worth reaches zero is eliminated.</p>
    </section>

    <section id="rules-death">
      <h2>Elimination</h2>
      <p>A snake is eliminated in any of these cases:</p>
      <ul>
        <li>Its head touches another snake's <strong>body</strong> (reason <code>bodyCollision</code>). A snake's own body does not count.</li>
        <li>Two heads make <strong>head-to-head</strong> contact (<code>headToHead</code>). The snake with the higher worth survives; if the worths are equal, both are eliminated.</li>
        <li>Its worth reaches <strong>zero</strong> (<code>zeroWorth</code>).</li>
      </ul>
      <p>The arena has no walls: crossing its left, right, top or bottom edge wraps the snake to the opposite edge. Food pickup and snake collisions use the shortest wrapped distance, so entities on opposite sides of the map can interact across the seam.</p>
      <p>While a snake has spawn protection it cannot be eliminated by collisions, but its body still counts as an obstacle for other snakes.</p>
      <p>When a snake is eliminated, its entire worth moves to the pending floor pool and <code>floor(worth / $0.50)</code> balls of $0.50 are created. They are spaced evenly along the snake's path, from its head to the end of its body. The part of the worth below $0.50 stays in the pending pool. The snake that caused the elimination receives nothing directly; balls are collected like any others.</p>
    </section>

    <section id="rules-cashout">
      <h2>Cash-out</h2>
      <p>Requesting a cash-out starts an authoritative <strong>10-second countdown</strong> (300 simulation ticks). The snake remains in the arena, can keep moving and boosting, continues paying charges, and remains fully vulnerable. The player may cancel at any time before completion.</p>
      <div class="split two">
        <div><strong>100%</strong><span>Payout to the player</span></div>
        <div><strong>0%</strong><span>Platform fee</span></div>
      </div>
      <p>If the snake survives until the completion tick, it is removed and paid based on its worth at that tick. There is currently no platform fee, so the receipt shows <code>payoutNanos = grossNanos</code> and <code>platformFeeNanos = 0</code>. The published economy configuration includes <code>cashOutDelayTicks</code> = 300, <code>payoutBasisPoints</code> = 10000 and <code>platformFeeBasisPoints</code> = 0.</p>
      <p>Dying during the countdown cancels the cash-out and redistributes the snake's worth normally. Closing the tab, navigating away, or losing the connection abandons the snake: boost turns off, it coasts in its last direction, and it remains vulnerable and keeps paying starvation tax. A pending cash-out remains active and pays if the abandoned snake survives to the completion tick, so disconnecting cannot remove it from an imminent collision.</p>
    </section>

    <section id="rules-placement">
      <h2>Money placement</h2>
      <p>Money enters the arena in three ways: the initial treasury, the pending floor pool (starvation tax, boost cost and eliminated worth) and boost balls. Every placement follows explicit geometric rules with no random input.</p>

      <h3>Pending floor pool release</h3>
      <p>After each tick's charges, the server releases the pool as balls:</p>
      <pre class="formula">releasable = pending_floor − boost_reserve
while releasable ≥ $0.50 and released_this_call &lt; 256:
    create one $0.50 ball at the current lowest-AUM point
    releasable −= $0.50</pre>
      <p>This runs once per tick and once after every cash-out. All balls released in the same call use the same computed coordinate and intentionally stack.</p>

      <h3>The AUM weight map</h3>
      <p>Each snake adds weight to the arena that falls off with squared wrapped distance from its head. The weight at a point <em>p</em> is:</p>
      <pre class="formula">W(p) = Σ over snakes i of   worth_i / ( torus_distance(p, head_i)² + 100 )</pre>
      <p>Worth is in nano-dollars and positions are in world units (the ×100 wire scaling does not apply). Distance uses the shortest route across the wrapping square on each axis. Only heads count, and the constant 100 keeps the weight finite at a head.</p>

      <h3>Spawn point</h3>
      <p>The spawn point is the point of lowest weight, found by scanning a fixed grid:</p>
      <pre class="formula">cell     = 6000 / 64 = 93.75 units
centers  = ( −3000 + (column + 0.5) × cell ,  −3000 + (row + 0.5) × cell ),  column, row = 0 … 63
spawn    = center with the lowest W(p)</pre>
      <p>Cells are scanned row by row from the top-left, and a later cell replaces the best one only if its weight is strictly lower, so ties go to the first cell scanned. If no snake holds any worth, released floor money uses the arena center. For example, with a $30 snake at (1000, 0) and a $10 snake at (0, 1000), the spawn point lies in the quadrant where both x and y are negative, on the far side from both.</p>

      <h3>Stacking at the spawn point</h3>
      <p>Released floor balls receive no offset. Every ball is placed at the exact lowest-AUM coordinate computed for that release call, so multiple balls may occupy the same point.</p>

      <h3>Initial treasury grid</h3>
      <p>The initial treasury uses a separate centered grid. Each coordinate represents $1 and receives two stacked $0.50 balls. Grid coordinates are 50 world units apart. The number of rows and columns is the closest exact rectangular factorization of the number of whole-dollar coordinates.</p>
      <pre class="formula">coordinates = treasury / $1
balls_at_each_coordinate = 2 × $0.50
spacing = 50 world units

$100 treasury → 100 coordinates → centered 10 × 10 grid</pre>

      <h3>What does not use the spawn point</h3>
      <ul>
        <li><strong>Boost balls:</strong> created at the position of a boosting snake, each time the boost reserve reaches $0.50. When several snakes are boosting, they take turns.</li>
        <li><strong>Elimination balls:</strong> created along the eliminated snake's path, as described in <a href="#/rules/death">Elimination</a>.</li>
      </ul>

      <p>The seed (<code>placementSeed</code>) and rule version (<code>placementVersion</code>, currently 4) are published in the bootstrap's <code>economyConfig</code>. The spawn point can be computed from the public snake state. The exact scatter position of a released ball also depends on the counter <em>n</em> above, which is not published. The minimap marks the current spawn point with a pink crosshair.</p>
    </section>

    <section id="rules-ledger">
      <h2>Ledger</h2>
      <p>The server checks after every tick and every exit that money is conserved:</p>
      <pre class="formula">ticket inflow + treasury seed
    = live worth + floor balls + pending floor + payouts + platform fees</pre>
      <p>The published <code>economy</code> object carries <code>pendingFloorNanos</code>, <code>ticketInflowNanos</code>, <code>payoutsNanos</code> and <code>platformFeesNanos</code> on every delta.</p>
    </section>

    <section id="rules-system">
      <h2>System</h2>
      <ul>
        <li>The Paper tier uses a simulated, in-memory ledger. It does not accept, hold, or pay real money or crypto.</li>
        <li>The server is authoritative. Clients send intent (direction, boost, cash-out, entry) and the server computes everything else.</li>
        <li>Human and bot players are subject to the same rules. See the <a href="#/docs">API docs</a>.</li>
      </ul>
    </section>
  </article>`;
}

/** Fills in the live tier once the server config arrives; leaves the page untouched if the server is unreachable. */
export async function hydrateRules(root: ParentNode): Promise<void> {
  const target = root.querySelector<HTMLElement>("#rules-live");
  if (!target) return;
  try {
    const response = await fetch("/config");
    if (!response.ok) return;
    const config = await response.json() as { tierLabel: string; ticketNanos: number };
    target.innerHTML = `This server is running the <strong>${escapeHtml(config.tierLabel)}</strong> tier with a <strong>${formatMoney(config.ticketNanos)}</strong> ticket.`;
  } catch {
    // Offline docs are still useful without the live tier.
  }
}

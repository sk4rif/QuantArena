import { escapeHtml } from "../../../util/html";
import { endpointUrl, LOCAL_REGION } from "../../regions";
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
      <p>Entering costs one <strong>ticket</strong>, and the snake starts with a worth equal to that ticket. Re-entering after an elimination or a cash-out records a new ticket. Spectating is free: it creates no snake, records no ticket, and takes no snake or food id, so later ids, contested pickups, and the state digest stay the same whether or not anyone is watching.</p>

      <h3>Snake spawn</h3>
      <p>The first snake in an empty arena is placed at the center, <code>(0, 0)</code>, facing east (aim 0). Every later snake is placed on a fixed 64 × 64 grid:</p>
      <pre class="formula">cell    = 6000 / 64 = 93.75 units
centers = ( −3000 + (column + 0.5) × cell ,  −3000 + (row + 0.5) × cell ),  column, row = 0 … 63
clearance(cell) = minimum squared wrapped distance from the cell center
                  to every existing snake head and every body point
spawn   = the center with the greatest clearance</pre>
      <p>Cells are scanned row by row from the top-left. A later cell replaces the current best only when its clearance is strictly greater, so a tie keeps the first cell scanned. The new snake faces the arena center (<code>atan2(−y, −x)</code>). Its body is a 24-point circle of radius <code>10 × 25 / 2π</code> trailing that heading. Spawn protection lasts 60 ticks, which is 2 seconds at 30 ticks per second: the snake cannot be eliminated by a collision, but its body is still an obstacle for other snakes.</p>
      <p>When a server starts, its arena holds a treasury of 16 tickets, laid out as coins worth 1% of the tier's ticket (see <a href="#/rules/placement">Money placement</a>).</p>
    </section>

    <section id="rules-controls">
      <h2>Controls</h2>
      <p>A player sends steering, boost on/off, and cash-out start or cancellation inputs. The browser client derives the direction from the pointer and boost from the mouse buttons or <kbd>Space</kbd>. Press <kbd>C</kbd> to start cash-out and <kbd>X</kbd> to cancel its countdown. Bots send the same inputs through the <a href="#/docs">API</a>.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Arena</td><td>6,000 × 6,000 square; crossing an edge wraps to the opposite edge</td></tr>
          <tr><td>Simulation rate</td><td>30 ticks per second</td></tr>
          <tr><td>Speed</td><td>150 units/s, or 440 units/s while boosting</td></tr>
          <tr><td>Turn rate</td><td>Up to 3.4 rad/s toward the requested direction</td></tr>
          <tr><td>Coil</td><td>The newest three body points stay on the head's path. Each new point pulls older points inward, so a held turn tightens instead of sealing the head inside a ring</td></tr>
        </tbody>
      </table></div>
    </section>

    <section id="rules-worth">
      <h2>Worth and growth</h2>
      <p>Money is counted in nano-dollars ($1 = 1,000,000,000) with exact integer arithmetic, so rounding neither creates nor destroys money. Each tier has a single ball denomination equal to <strong>1% of its ticket</strong> ($0.05 for a $5 ticket and $1.50 for a $150 ticket). Collecting a ball adds its value to the snake's worth.</p>
      <p>A snake's size is derived from its worth relative to the tier's ticket:</p>
      <pre class="formula">radius      = clamp(12 × √(worth / ticket), 10, 48)
body points = clamp(round(24 × worth / ticket), 8, 1200)</pre>
      <p>Doubling the worth increases the radius by about 41% and doubles the number of body points. Collision size uses this radius.</p>
    </section>

    <section id="rules-costs">
      <h2>Costs</h2>
      <p>Starvation and inheritance taxes both fall as effective floor liquidity rises. Visible floor balls and money already committed to the pending floor pool both count:</p>
      <pre class="formula">P = total live snake worth
F = visible floor cash + pending floor cash
r = F / (P + F)
x = clamp((r − 0.25) / (0.65 − 0.25), 0, 1)
q = x²(3 − 2x)

starvation_rate = (96,266 − (96,266 − 25,672) × q) / 1,000,000,000 per tick
inheritance_tax = 20% − (20% − 2%) × q</pre>
      <p>There is no temporal smoothing: authoritative entries, pickups, deaths and exits affect the rates immediately. Smoothstep keeps the transition flat at the 25% and 65% boundaries. One starvation-rate snapshot applies to every snake in a tick. Each cash-out locks the current inheritance rate when its countdown starts.</p>
      <p>Each tick uses <code>effective_worth = max(worth, $5)</code>. At or below a 25% ratio, starvation has an approximate four-minute worth half-life and inheritance tax is 20%; at or above 65%, starvation has an approximate fifteen-minute half-life and inheritance tax is 2%. Each snake keeps its own starvation remainder and its own boost remainder. A charge is <code>(effective_worth × numerator + remainder) / denominator</code>, and the leftover stays on that snake until the next tick. Those remainders are not part of the published snapshot, so the exact charge on the following tick is not fixed by the public delta alone.</p>
      <pre class="formula">starvation_tax = effective_worth × starvation_numerator / 1,000,000,000
boost_cost     = effective_worth × 2,667 / 4,000,000        only while boosting</pre>
      <p>Both charges move from the snake into the pending floor pool. Boost cost also accumulates in a separate reserve; each time that reserve reaches the tier's coin value, one coin is created at the position of a boosting snake. On any tick in which no snake is boosting, the reserve is cleared and its money is released with the rest of the pending floor pool. A snake whose worth reaches zero is eliminated.</p>
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
      <p>When a snake is eliminated, its entire worth moves to the pending floor pool and <code>floor(worth / coin_value)</code> coins are created. They are spaced evenly along the snake's path, from its head to the end of its body. The part of the worth below one coin stays in the pending pool. The snake that caused the elimination receives nothing directly; balls are collected like any others.</p>
    </section>

    <section id="rules-cashout">
      <h2>Cash-out</h2>
      <p>Requesting a cash-out starts an authoritative <strong>10-second countdown</strong> (300 simulation ticks). The snake remains in the arena, can keep moving and boosting, continues paying charges, and remains fully vulnerable. The player may cancel at any time before completion.</p>
      <div class="split">
        <div><strong>2–20%</strong><span>Inheritance tax returned to the game</span></div>
        <div><strong>2%</strong><span>Platform fee voided after inheritance</span></div>
        <div><strong>78.4–96.04%</strong><span>Final payout to the player</span></div>
      </div>
      <p>When the countdown starts, the server locks the current inheritance rate and returns it to the player. That rate does not change during the countdown. If the snake survives until completion, the inheritance tax is calculated from its final worth, rounded down to whole nano-dollars, and added to the pending floor pool. Completing a cash-out does not release coins on its own. Later ticks emit that tax as collectible coins under the same cap as any other pending floor money: at most two coins per tick. The tax is returned entirely to the game and none of it goes to the platform.</p>
      <pre class="formula">inheritance = floor(gross × inheritance_basis_points / 10,000)
after_tax  = gross − inheritance
platform_fee = floor(after_tax × 2%)
payout      = after_tax − platform_fee</pre>
      <p>The 2% platform fee is calculated on the amount remaining after inheritance tax. While every tier uses simulated money, that fee is voided: it leaves the simulated economy and is not collected by the platform or returned to the floor. Before cash-out, the UI shows an estimate based on the current rate. During the countdown, it shows the locked rate and continuously updates the payout for the snake's changing worth. The authoritative receipt itemizes the exact amount returned to the game, the amount voided and the final payout.</p>
      <p>Dying during the countdown cancels the cash-out and redistributes the snake's worth normally. Closing the tab, navigating away, or losing the connection abandons the snake: boost turns off, it coasts in its last direction, and it remains vulnerable and keeps paying starvation tax. A pending cash-out remains active and pays if the abandoned snake survives to the completion tick, so disconnecting cannot remove it from an imminent collision.</p>
    </section>

    <section id="rules-placement">
      <h2>Money placement</h2>
      <p>Money enters the arena in three ways: the initial treasury, the pending floor pool (starvation tax, inheritance tax, boost cost and eliminated worth) and boost balls. The coordinate of a general floor coin follows public geometry: snake heads, worth, and the grids below. How many coins a tick releases also depends on two quantities the server carries between ticks and does not publish: each snake's starvation and boost fractional remainders, and the boost reserve held inside the pending floor pool.</p>

      <h3>Pending floor pool release</h3>
      <p>After each tick's charges and boost balls, the server releases the pool as balls:</p>
      <pre class="formula">coin_value = ticket / 100
releasable = pending_floor − boost_reserve
released = 0
while releasable ≥ coin_value and released &lt; 2:
    create one coin at the current lowest-AUM point
    releasable −= coin_value
    released += 1</pre>
      <p>This runs once per tick. A cash-out adds inheritance tax to the pending pool and does not release coins by itself; those coins come out on later ticks, at most two per tick. Coins released on the same tick use the same computed coordinate and intentionally stack.</p>

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
      <p>The initial treasury uses a centered grid covering the full map. One coin is placed at each coordinate, with adjacent coordinates 150 world units apart. The centers run from −2,925 through 2,925 on each axis.</p>
      <pre class="formula">positions_per_axis = 6,000 / 150 = 40
coordinates = 40 × 40 = 1,600
coins = 1,600 × 1% of ticket = 16 tickets

Paper/Casual $80 · Mid $400 · Standard $800 · High $1,600 · Elite $2,400</pre>

      <h3>What does not use the spawn point</h3>
      <ul>
        <li><strong>Boost balls:</strong> created at the position of a boosting snake, each time the boost reserve reaches one coin. When several snakes are boosting, they take turns in join order (ascending id).</li>
        <li><strong>Elimination balls:</strong> created along the eliminated snake's path, as described in <a href="#/rules/death">Elimination</a>.</li>
      </ul>

      <p>The floor-spawn coordinate can be computed from the public snake heads and worth, and the treasury grid can be computed from <code>ticketNanos</code> and <code>initialTreasuryNanos</code>. How many coins the next tick releases also depends on the unpublished boost reserve and on fractional remainders carried from earlier ticks. The minimap marks the current spawn point with a pink crosshair.</p>
    </section>

    <section id="rules-ledger">
      <h2>Ledger</h2>
      <p>The server checks after every tick and every exit that money is conserved:</p>
      <pre class="formula">ticket inflow + initial treasury
    = live worth + floor balls + pending floor + payouts + voided platform fees</pre>
      <p><code>platformFeesNanos</code> is the cumulative simulated amount removed from circulation, not platform revenue. The published <code>economy</code> object carries <code>floorLiquidityRatioPpm</code>, <code>starvationTaxNumerator</code> and <code>inheritanceTaxBasisPoints</code> whenever they change, so humans and bots can reproduce the current rates. A delta that omits <code>economy</code> means those values are unchanged.</p>
    </section>

    <section id="rules-system">
      <h2>System</h2>
      <ul>
        <li>The Paper tier uses a simulated, in-memory ledger. It does not accept, hold, or pay real money or crypto.</li>
        <li>The server is authoritative. Clients send intent (direction, boost, cash-out, entry) and the server computes everything else.</li>
        <li>When queued commands, a simulation tick, and a state publish are ready together, the server applies every command already queued, in arrival order, then the tick, then the publish. An input or cash-out that has already arrived is included in that tick. A publish on that same wakeup includes the tick that just ran.</li>
        <li>A food ball that more than one snake can collect in the same tick goes to the lower id, which is the earlier joiner. Equal leaderboard worth ranks the lower id first. Equal head-to-head worth eliminates both snakes. Ties on the floor-spawn grid and the snake-spawn grid keep the first cell scanned.</li>
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
    // The site may be served from a different host than the arenas, so ask the default level's first arena.
    const server = snakeGame.levels.find((level) => level.availability === "open")?.servers[0];
    const response = await fetch(endpointUrl(server?.origin ?? "", "/config"));
    if (!response.ok) return;
    const config = await response.json() as { tierLabel: string; ticketNanos: number };
    const subject = !server || server.region.key === LOCAL_REGION.key ? "This server" : `The ${escapeHtml(server.region.label)} server`;
    target.innerHTML = `${subject} is running the <strong>${escapeHtml(config.tierLabel)}</strong> tier with a <strong>${formatMoney(config.ticketNanos)}</strong> ticket.`;
  } catch {
    // Offline docs are still useful without the live tier.
  }
}

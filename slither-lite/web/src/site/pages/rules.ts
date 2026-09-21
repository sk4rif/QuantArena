import { escapeHtml } from "../../util/html";
import { formatMoney } from "../../net/protocol";
import { findGame, isFree } from "../catalog";

// Derived from the catalog so the table cannot drift from the level-select page.
const tiers = (findGame("snake")?.levels ?? []).map((level) => ({
  label: level.label,
  // A paper level costs nothing, but its simulated ticket still drives worth and geometry.
  ticket: isFree(level) ? `Free (${formatMoney(level.stakeNanos)} simulated)` : formatMoney(level.stakeNanos),
  money: level.money,
  status: level.availability === "open" ? "Open" : "Not open yet",
}));

export function renderRules(): string {
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
      <p>Entering costs one <strong>ticket</strong>, and the snake starts with a worth equal to that ticket. Re-entering after an elimination or a cash-out records a new ticket. New snakes are protected from collisions for 2 seconds.</p>
      <p>When a server starts, its arena holds a treasury of 20 tickets, laid out as $0.50 balls (see <a href="#/rules/placement">Money placement</a>).</p>
    </section>

    <section id="rules-controls">
      <h2>Controls</h2>
      <p>A player sends three kinds of input: a steering direction, boost on/off, and cash-out. The browser client derives the direction from the pointer and boost from the mouse buttons or <kbd>Space</kbd>. Bots send the same inputs through the <a href="#/docs">API</a>.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Arena</td><td>Circle of radius 3,000 world units, centered on (0, 0)</td></tr>
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
        <li>It touches the <strong>arena wall</strong> (<code>boundary</code>), i.e. its head is farther from the center than 3,000 units minus its radius.</li>
        <li>Its worth reaches <strong>zero</strong> (<code>zeroWorth</code>).</li>
      </ul>
      <p>While a snake has spawn protection it cannot be eliminated by the wall or by collisions, but its body still counts as an obstacle for other snakes.</p>
      <p>When a snake is eliminated, its entire worth moves to the pending floor pool and <code>floor(worth / $0.50)</code> balls of $0.50 are created. They are spaced evenly along the snake's path, from its head to the end of its body. The part of the worth below $0.50 stays in the pending pool. The snake that caused the elimination receives nothing directly; balls are collected like any others.</p>
    </section>

    <section id="rules-cashout">
      <h2>Cash-out</h2>
      <p>A cash-out removes the snake from the arena and pays out its worth.</p>
      <div class="split two">
        <div><strong>100%</strong><span>Payout to the player</span></div>
        <div><strong>0%</strong><span>Platform fee</span></div>
      </div>
      <p>There is currently no platform fee. Every cash-out pays the full worth, and the receipt (<code>grossNanos</code>, <code>payoutNanos</code>, <code>platformFeeNanos</code>) shows <code>payoutNanos = grossNanos</code> and <code>platformFeeNanos = 0</code>. The rates are part of the published economy configuration (<code>payoutBasisPoints</code> = 10000, <code>platformFeeBasisPoints</code> = 0), so a future change would be visible to clients.</p>
      <p>Closing the tab or losing the connection triggers the same cash-out automatically. Intentional cash-outs return a receipt.</p>
    </section>

    <section id="rules-placement">
      <h2>Money placement</h2>
      <p>Money enters the arena in three ways: the initial treasury, the pending floor pool (starvation tax, boost cost and eliminated worth) and boost balls. Everything is placed by deterministic rules from public state and a published seed.</p>

      <h3>Pending floor pool release</h3>
      <p>After each tick's charges, the server releases the pool as balls:</p>
      <pre class="formula">releasable = pending_floor − boost_reserve
while releasable ≥ $0.50 and released_this_call &lt; 256:
    create one $0.50 ball at a placement position
    releasable −= $0.50</pre>
      <p>This runs once per tick (source <code>Tax</code>, source id = the tick number) and once after every cash-out (source <code>Exit</code>, source id = the receipt id). Balls are placed one at a time using the rule below.</p>

      <h3>The AUM weight map</h3>
      <p>Each snake adds weight to the arena that falls off with squared distance from its head. The weight at a point <em>p</em> is:</p>
      <pre class="formula">W(p) = Σ over snakes i of   worth_i / ( |p − head_i|² + 100 )</pre>
      <p>Worth is in nano-dollars and positions are in world units (the ×100 wire scaling does not apply). Only heads count, and the constant 100 keeps the weight finite at a head.</p>

      <h3>Spawn point</h3>
      <p>The spawn point is the point of lowest weight, found by scanning a fixed grid:</p>
      <pre class="formula">cell     = 6000 / 64 = 93.75 units
centers  = ( −3000 + (column + 0.5) × cell ,  −3000 + (row + 0.5) × cell ),  column, row = 0 … 63
allowed  = centers with x² + y² ≤ 2850²          (95% of the arena radius)
spawn    = allowed center with the lowest W(p)</pre>
      <p>Cells are scanned row by row from the top-left, and a later cell replaces the best one only if its weight is strictly lower, so ties go to the first cell scanned. If no snake holds any worth, there is no spawn point and the fallback below is used. For example, with a $30 snake at (1000, 0) and a $10 snake at (0, 1000), the spawn point lies in the quadrant where both x and y are negative, on the far side from both.</p>

      <h3>Scatter around the spawn point</h3>
      <p>Balls are not stacked on the spawn point. Ball number <em>n</em> is offset by a hash of its origin:</p>
      <pre class="formula">base   = seed ⊕ rotl(tick, 13) ⊕ rotl(source, 29) ⊕ rotl(source_id, 41) ⊕ (n × 0x9E3779B97F4A7C15)
h1     = splitmix64(base)
h2     = splitmix64(h1)
u(h)   = (h &gt;&gt; 40) / 2²⁴                                  a number in [0, 1)
angle  = u(h1) × 2π
radius = √u(h2) × 60
ball   = spawn + radius × (cos angle, sin angle)</pre>
      <p>If the ball lands outside 2,850 units from the center, it is scaled back toward the center onto that circle. Here <code>source</code> is 1 for the treasury, 2 for the per-tick release and 3 for the cash-out release; <code>n</code> is a counter of balls placed by this rule, starting at 0. All arithmetic on <code>base</code> and the hashes is 64-bit and wrapping; <code>u</code>, the angle, the radius and the resulting positions are computed in 32-bit floating point. The splitmix64 function is:</p>
      <pre class="formula">splitmix64(v):
    v = v + 0x9E3779B97F4A7C15
    v = (v ⊕ (v &gt;&gt; 30)) × 0xBF58476D1CE4E5B9
    v = (v ⊕ (v &gt;&gt; 27)) × 0x94D049BB133111EB
    return v ⊕ (v &gt;&gt; 31)</pre>

      <h3>Fallback when no snake holds worth</h3>
      <p>The initial treasury is placed while the arena is empty, so it uses the same hash with a different radius:</p>
      <pre class="formula">ball = ( u(h2) × 2850 ) × (cos angle, sin angle)</pre>
      <p>Because the radius is linear in <code>u(h2)</code>, this places more balls near the center per unit of area.</p>

      <h3>What does not use the spawn point</h3>
      <ul>
        <li><strong>Boost balls:</strong> created at the position of a boosting snake, each time the boost reserve reaches $0.50. When several snakes are boosting, they take turns.</li>
        <li><strong>Elimination balls:</strong> created along the eliminated snake's path, as described in <a href="#/rules/death">Elimination</a>.</li>
      </ul>

      <p>The seed (<code>placementSeed</code>) and rule version (<code>placementVersion</code>, currently 3) are published in the bootstrap's <code>economyConfig</code>. The spawn point can be computed from the public snake state. The exact scatter position of a released ball also depends on the counter <em>n</em> above, which is not published. The minimap marks the current spawn point with a pink crosshair.</p>
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

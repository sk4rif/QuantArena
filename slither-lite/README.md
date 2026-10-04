# QuantArena Slither Lite

A server-authoritative multiplayer snake arena with a Rust engine, HTML5 Canvas client, and an exact simulated-dollar economy.

> This milestone uses an in-memory simulated ledger. It does not accept, custody, settle, or pay real cryptocurrency.

## Economy

Each Rust server runs one fixed tier selected by `SLITHER_TIER`:

| Tier | Ticket |
|---|---:|
| Paper (paper money, default) | $5 |
| Casual | $5 |
| Mid | $25 |
| Standard | $50 |
| High | $100 |
| Elite | $150 |

Entering and re-entering records a new simulated ticket inflow and sets the snake’s worth to that ticket. The arena begins with deterministic floor liquidity worth 20 tickets.

Currency is accounted in nano-dollars (`$1 = 1,000,000,000`) using integer arithmetic. There is a single ball denomination: $0.50.

At every 30 Hz simulation tick:

```text
effective_worth     = max(worth, $5)
starvation_tax      = effective_worth × 0.00005
boost_cost          = effective_worth × 0.000889 × 0.5 × 3
```

Formula remainders carry between ticks, preventing rounding leakage. Starvation tax moves into the shared floor pool. Boost cost accumulates in a reserve; each time it reaches $0.50, one $0.50 ball is created at the position of a boosting snake. The reserve is cleared on any tick with no boosting snake, and its money joins the general floor pool. Reaching zero worth eliminates the snake.

When a snake dies, its full worth moves to the pending floor pool and `floor(worth / $0.50)` balls are spread evenly along its head/body path; the sub-$0.50 remainder stays in the pool. The killer does not receive value automatically.

Cash-out is server-authoritative and takes 300 simulation ticks (10 seconds). During the countdown the snake remains playable, continues paying charges, and can still die; the player may cancel before completion. If the snake survives, its worth at the completion tick is paid at 100% with a 0% platform fee. The delay and rates are published as `cashOutDelayTicks` (300), `payoutBasisPoints` (10000), and `platformFeeBasisPoints` (0).

A completed cash-out returns an authoritative in-memory receipt. Closing the tab, navigating away, or losing the connection abandons the snake: boost turns off, it coasts in its last direction, and it remains vulnerable and continues paying starvation tax. A pending cash-out completes if the abandoned snake survives to its deadline; if it dies first, its full worth is redistributed along its body and no payout is recorded.

The ledger continuously enforces:

```text
ticket inflow + treasury seed
  = live worth + floor balls + pending floor value + payouts + platform fees
```

## Visible growth

Geometry is relative to the server ticket, so every tier starts at the same size:

```text
radius      = clamp(12 × sqrt(worth / ticket), 10, 48)
body points = clamp(round(24 × worth / ticket), 8, 1200)
```

Doubling worth therefore increases girth by approximately 41% and doubles body length. Collision size and rendering use this authoritative radius.

## Deterministic placement

Pending-floor releases (starvation tax, boost reserve leftovers, eliminated remainders) spawn in the zone of the arena with the lowest AUM weight. Every snake adds weight to the map that fades with distance:

```text
weight(x, y) = sum_p( AUM_p / (torus_distance((x, y), pos_p)^2 + 100) )
spawn        = argmin weight(x, y)       // scanned on a 64 x 64 grid across the square
```

Ties go to the first cell scanned, row by row, so the result is deterministic. A richer snake pushes the spawn point further away.

Balls scatter within `SPAWN_SCATTER_RADIUS` (60 units, wrapping across square edges) of that point, offset by a hash of:

```text
placement_seed + tick + source + source_id + ball_index
```

The spawn point is shown on the minimap as a pink crosshair. When no snake holds AUM (e.g. the initial treasury), placement falls back to deterministic uniform square coordinates. Tier, denominations, economy cadence, seed, and placement version are published to clients in the bootstrap. The spawn point can be computed from public snake state; exact scatter positions also depend on an internal ball counter that is not published. The full formulas are on the website Rules page. Kill balls follow the dead body and boost balls follow the trail instead of using floor placement.

## Replication

- Rust/Tokio/Axum runs one authoritative 30 Hz arena.
- Browsers send only aim, boost, entry, and cash-out start/cancel intent.
- Join sends a complete global bootstrap; 15 Hz ordered deltas then contain snake patches and ball additions/removals.
- Every input includes the client’s latest state sequence and canonical 64-bit digest.
- A sequence gap, digest mismatch, or slow-client overflow triggers a complete state resync.
- Prediction/interpolation is visual only and remains separate from the hashed authoritative replica.

Protocol v4 adds the authoritative cash-out countdown and cancellation messages while retaining the square arena, worth/economy, re-entry, and targeted lifecycle messages.

## Bot API

Quant developers can drive a snake programmatically over a second WebSocket endpoint, `/bot` (e.g. `ws://127.0.0.1:3001/bot`). **Server messages are identical to the browser endpoint** (`bootstrap`, `delta`, `entered`, `eliminated`, `cashOutPending`, `cashOutCanceled`, `cashOutReceipt`, `pong`, `error`). Only client input is simplified: bots do not compute or send replica digests, so `stateSequence` / `stateDigest` are not needed and no digest check is performed. A `delta` still carries `sequence` and `digest` if you want to verify your own replica; on a gap, send `resync`.

Client messages (JSON text frames):

| Message | Fields | Effect |
|---|---|---|
| `join` | `protocol` (4), `name` (1–20 chars), `skin` (optional, default `blue`) | Must be the first message; server replies with `bootstrap`. |
| `input` | `x`, `y`, `boost` (optional, default `false`) | Steer toward the vector `(x, y)`; `y` grows downward, as in the world. Magnitude is ignored. A zero or non-finite vector returns `invalidVector`. |
| `cashOut` | – | Start the 10-second countdown (`cashOutPending`); the snake remains active and vulnerable. |
| `cancelCashOut` | – | Cancel a pending countdown (`cashOutCanceled`). |
| `reenter` | – | Buy back in after `eliminated` or a cash-out (`entered`). |
| `resync` | – | Request a fresh `bootstrap` (max one per second). |
| `ping` | `sentAt` | Replies `pong` with the same `sentAt`. |

```json
{"type":"join","protocol":4,"name":"my-bot"}
{"type":"input","x":0.7,"y":-0.7,"boost":true}
{"type":"cashOut"}
{"type":"cancelCashOut"}
```

Conventions: positions, radii, and speeds on the wire are integers scaled by 100 (angles by 10,000), and money is in nano-dollars. The snake turns toward the requested direction at a bounded turn rate, so inputs are steering intent rather than teleports. Send inputs as often as you like, ideally no faster than the 30 Hz tick.

`bots/example_bot.py` is a runnable reference (chases the nearest ball, cashes out at 2x the ticket, re-enters when eliminated):

```bash
pip install websockets
python bots/example_bot.py ws://127.0.0.1:3001/bot my-bot
```

The endpoint is unauthenticated, like `/ws`. It is intended for the simulated ledger only.

## Website

The Vite client is the **Zero Sum** site: a platform listing games whose outcome comes from skill rather than luck. QuantArena (this snake game) is the first game. It is served from the same origin as the game and routing is hash-based, so the Rust server needs no extra routes.

- **Games** (`#/`): the game list, and the landing page. Each card links to that game's levels rather than straight into an arena.
- **About** (`#/about`): what the platform is and how a game works. This is deliberately not on the landing page, which leads with the games themselves.
- **Levels** (`#/game/snake`): the level-select page for a game. Levels share the rules and the API and differ only by the stake; only Paper is open today.
- **Arena** (`#/play/snake/paper`): the game itself, reachable only through a concrete open level. The lobby can enter with a ticket or spectate the live room for free, then enter later from the spectator HUD. A hash without a valid, open level redirects to the level-select page, and `#/play` alone redirects too.
- **Rules** (`#/rules`): tiers, growth, tax and boost costs, elimination, cash-out (100% payout, 0% fee), and the exact money-placement maths. It also shows the tier the server is running.
- **API Docs** (`#/docs`): the Bot API with Python and JavaScript quick starts, message tables, units, and error codes.
- **Sign in**: a dialog reachable from the header and the lobby. It is visual only for now.

The header navigation is scoped, because levels, rules and the API are all per-game and mean nothing before a game is chosen. Each route declares a `nav` scope in `web/src/site/routes.ts`:

| Scope | Links | Shown on |
|---|---|---|
| `platform` | Games, About | `#/`, `#/about` |
| `game` | Levels, Rules, API Docs | `#/game/*`, `#/play/*`, `#/rules`, `#/docs` |

The "Paper money" badge follows the same rule and only appears in the game scope. The brand always returns to the game list.

Leaving the arena while a snake is live asks for confirmation, because disconnecting permanently abandons control while the snake coasts with boost off until it dies or completes a pending cash-out. Closing the browser tab also triggers the browser's leave warning. The arena only boots (assets, renderer, `/config`) the first time the play route is opened, so the content pages do not pay for it.

### Game modules and the registry

Zero Sum platform code lives in `web/src/site`, `web/src/auth`, and `web/src/main.ts`. Each game owns its metadata, pages, browser runtime, networking, rendering, and view markup under `web/src/games/<game-id>`. `web/src/games/index.ts` is the only registry the platform shell reads. The Rust implementation follows the same boundary under `src/games/<game-id>`; the root server only composes game routes with the static Zero Sum site.

Because a Rust server runs exactly one tier, every level is a separate server process. `web/src/games/snake/index.ts` lists Snake's levels with a `key` (matching `SLITHER_TIER`), a stake, an `availability`, and an `origin` serving that level's `/config` and `/ws` (empty string = the origin the site is served from).

Today only Paper is `open` and every `origin` is the current one, so the client still talks to a single server. To add a level, deploy a server with that `SLITHER_TIER`, then set the level's `origin` and flip it to `open`. The lobby compares the chosen level's `key` against the `tier` reported by `/config` and warns on a mismatch. The Rules page derives its tier table from the same game module, so the two cannot drift. Replacing the registry with a server-side directory endpoint is the natural next step.

### Adding real accounts later

The UI only talks to the `AuthService` interface in `web/src/auth/service.ts` (`user`, `subscribe`, `signIn`, `signUp`, `signOut`). Today `web/src/auth/index.ts` exports `UnavailableAuthService`, which rejects every attempt with a friendly message. To ship accounts, implement `AuthService` against your backend, export it from `auth/index.ts`, and remove the "Preview" notice in `auth/ui.ts`. The header, the sign-in dialog, and the lobby's default player name already react to `auth.user`. Server-side, the bot endpoint (`/bot`) is the natural place to require an API key once accounts exist.

## Requirements

- Rust 1.92 or newer
- Node.js 24 or newer
- npm 11 or newer

## Development

Install client dependencies once:

```bash
cd web
npm install
```

Run the Rust server from the project root:

```bash
cargo run
```

Run Vite in another terminal:

```bash
cd web
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/ws`, `/config`, and `/health` to `127.0.0.1:3001`.

Configure a tier or deterministic seed:

```bash
SLITHER_TIER=elite SLITHER_PLACEMENT_SEED=12345 cargo run
```

Available environment variables:

- `SLITHER_BIND` — bind address, default `127.0.0.1:3001`
- `SLITHER_TIER` — `paper` (default), `casual`, `mid`, `standard`, `high`, or `elite`
- `SLITHER_PLACEMENT_SEED` — unsigned 64-bit deterministic placement seed
- `RUST_LOG` — tracing filter

## Production-style local run

```bash
cd web
npm run build
cd ..
cargo run --release
```

Open `http://127.0.0.1:3001`. Axum serves `web/dist` and the WebSocket from one origin.

## Controls

- Move the pointer to steer.
- Hold either mouse button or Space to boost.
- Collect balls to increase worth, girth, and length.
- Crossing any map edge wraps you to the opposite edge; there are no boundary deaths.
- Hitting another snake’s body eliminates you; crossing your own body is allowed.
- The higher-worth snake wins head-to-head contact; equal-worth snakes both die.
- Use **Cash out** or press **C** to start the 10-second countdown; press **X** to cancel it. Survive until it completes to receive the authoritative simulated receipt.
- The minimap shows every snake and a logarithmic heatmap of collectible money concentration; your marker is white/cyan.

## Verification

From the project root:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

From `web/`:

```bash
npm audit --audit-level=moderate
npm run typecheck
npm test
npm run build
```

Rust tests cover ticket/formula fixtures, remainder preservation, rake, conservation, treasury decomposition, deterministic placement, geometry, boost batches, collection, death redistribution, zero-worth elimination, cash-out, disconnect, and re-entry. Rust and TypeScript share a canonical state-digest fixture.

## Current scope

Included: one in-memory arena, human multiplayer, free live spectating, all six configurable tiers, simulated entries/payouts, a `/bot` API, treasury balls, growth, boost trails, starvation tax, collision/death, ticketed re-entry, cash-out receipts, leaderboard, deterministic placement, state resynchronization, and desktop controls.

Not included: real crypto, wallet authentication, custody/signing, persistence, bot authentication or rate limits, matchmaking, multiple simultaneous arenas, chat, mobile controls, and audio.

The texture files under `web/public/assets` came from the supplied reference project. Verify redistribution rights before publishing publicly.

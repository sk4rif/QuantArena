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

Entering and re-entering records a new simulated ticket inflow and sets the snake’s worth to that ticket. The arena begins with deterministic floor liquidity worth 16 tickets.

Currency is accounted in nano-dollars (`$1 = 1,000,000,000`) using integer arithmetic. Each tier has a single ball denomination equal to 1% of its ticket ($0.05 for a $5 ticket and $1.50 for a $150 ticket).

At every 30 Hz simulation tick, starvation and inheritance taxes both fall as effective floor liquidity rises:

```text
P = total live snake worth
F = visible floor cash + pending floor cash
r = F / (P + F)
x = clamp((r - 0.25) / (0.65 - 0.25), 0, 1)
q = x²(3 - 2x)

starvation numerator = 96,266 - (96,266 - 25,672) × q
inheritance tax      = 20% - (20% - 2%) × q
starvation tax       = max(worth, $5) × starvation numerator / 1,000,000,000
boost cost           = max(worth, $5) × 2,667 / 2,000,000
```

There is no temporal smoothing. One starvation snapshot applies to every snake in a tick; the endpoints correspond to approximate four-minute and fifteen-minute worth half-lives. Formula remainders carry between ticks, preventing rounding leakage. Starvation tax moves into the shared floor pool. Boost cost accumulates in a reserve; each time it reaches one coin, a coin is created at the position of a boosting snake. The reserve is cleared on any tick with no boosting snake, and its money joins the general floor pool. Reaching zero worth eliminates the snake.

When a snake dies, its full worth moves to the pending floor pool and `floor(worth / coin)` balls are spread evenly along its head/body path; the sub-coin remainder stays in the pool. The killer does not receive value automatically.

Cash-out is server-authoritative and takes 300 simulation ticks (10 seconds). During the countdown the snake remains playable, continues paying charges, and can still die; the player may cancel before completion. The current 2–20% inheritance rate is locked when the countdown starts. If the snake survives, that locked rate is applied to its final worth and returned entirely to the pending floor pool. A 2% platform fee is then applied to the post-inheritance amount. Because every tier currently uses simulated money, only that platform fee is voided; the inheritance tax remains in the game and none of it goes to the platform. The locked rate does not change during the countdown.

A completed cash-out returns an authoritative in-memory receipt. Closing the tab, navigating away, or losing the connection abandons the snake: boost turns off, it coasts in its last direction, and it remains vulnerable and continues paying starvation tax. A pending cash-out completes if the abandoned snake survives to its deadline; if it dies first, its full worth is redistributed along its body and no payout is recorded.

The ledger continuously enforces:

```text
ticket inflow + initial treasury
  = live worth + floor balls + pending floor value + payouts + voided platform fees
```

## Visible growth

Geometry is relative to the server ticket, so every tier starts at the same size:

```text
radius      = clamp(12 × sqrt(worth / ticket), 10, 48)
body points = clamp(round(24 × worth / ticket), 8, 1200)
```

Doubling worth therefore increases girth by approximately 41% and doubles body length. Collision size and rendering use this authoritative radius.

## Deterministic placement

Pending-floor releases (starvation tax, inheritance tax, boost reserve leftovers, eliminated remainders) spawn in the zone of the arena with the lowest AUM weight. Every snake adds weight to the map that fades with distance:

```text
weight(x, y) = sum_p( AUM_p / (torus_distance((x, y), pos_p)^2 + 100) )
spawn        = argmin weight(x, y)       // scanned on a 64 x 64 grid across the square
```

Ties go to the first cell scanned, row by row, so the result is deterministic. A richer snake pushes the spawn point further away.

All general floor balls released in one call stack at that exact coordinate. When no snake holds AUM, general floor releases use the arena center.

The initial treasury fills the map with a centered 40 × 40 grid: one coin at each of 1,600 coordinates, spaced 150 world units apart from −2,925 through 2,925 on each axis. Since each coin is 1% of a ticket, the treasury is worth 16 tickets: $80 in Paper/Casual, $400 in Mid, $800 in Standard, $1,600 in High, and $2,400 in Elite.

The spawn point is shown on the minimap as a pink crosshair and can be computed from public snake state. The full formulas are on the website Rules page. Elimination balls follow the dead body and boost balls follow the trail instead of using floor placement.

## Replication

- Rust/Tokio/Axum runs one authoritative 30 Hz arena.
- Browsers send only aim, boost, entry, and cash-out start/cancel intent.
- Join sends a complete global bootstrap; 15 Hz ordered deltas then contain snake patches and ball additions/removals.
- Every input includes the client’s latest state sequence and canonical 64-bit digest.
- A sequence gap, digest mismatch, or slow-client overflow triggers a complete state resync.
- Prediction/interpolation is visual only and remains separate from the hashed authoritative replica.

Protocol v5 publishes dynamic starvation and inheritance-tax bounds, the current effective-floor ratio and rates, and the exact inheritance amount and rate on cash-out receipts.

## Bot API

Quant developers can drive a snake programmatically over a second WebSocket endpoint, `/bot` (e.g. `ws://127.0.0.1:3001/bot`). **Server messages are identical to the browser endpoint** (`bootstrap`, `delta`, `entered`, `eliminated`, `cashOutPending`, `cashOutCanceled`, `cashOutReceipt`, `pong`, `error`). Only client input is simplified: bots do not compute or send replica digests, so `stateSequence` / `stateDigest` are not needed and no digest check is performed. A `delta` still carries `sequence` and `digest` if you want to verify your own replica; on a gap, send `resync`.

Client messages (JSON text frames):

| Message | Fields | Effect |
|---|---|---|
| `join` | `protocol` (5), `name` (1–20 chars), `skin` (optional, default `blue`) | Must be the first message; server replies with `bootstrap`. |
| `input` | `x`, `y`, `boost` (optional, default `false`) | Steer toward the vector `(x, y)`; `y` grows downward, as in the world. Magnitude is ignored. A zero or non-finite vector returns `invalidVector`. |
| `cashOut` | – | Start the 10-second countdown (`cashOutPending`); the snake remains active and vulnerable. |
| `cancelCashOut` | – | Cancel a pending countdown (`cashOutCanceled`). |
| `reenter` | – | Buy back in after `eliminated` or a cash-out (`entered`). |
| `resync` | – | Request a fresh `bootstrap` (max one per second). |
| `ping` | `sentAt` | Replies `pong` with the same `sentAt`. |

```json
{"type":"join","protocol":5,"name":"my-bot"}
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
- **Rules** (`#/rules`): tiers, growth, tax and boost costs, elimination, dynamic inheritance-tax cash-out (78.4–96.04% payout after the 2% voided platform fee), and the exact money-placement maths. It also shows the tier the server is running.
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

Because a Rust server runs exactly one tier in one region, every (level, region) pair is a separate server process with its own arena. `web/src/games/snake/index.ts` lists Snake's levels with a `key` (matching `SLITHER_TIER`), a stake, an `availability`, and `servers`: one entry per region the level runs in, each with the origin serving its `/config`, `/health`, `/ws` and `/bot`. Those come from `web/src/games/snake/servers.ts`, the one file to edit when deploying (see [Deploying regions](#deploying-regions)). A level with no regional origins falls back to the site's own origin, which is how local development works.

When a game runs in more than one region, its levels page shows a region picker with live ping to each region (measured against `/health`) and an Auto option that picks the lowest. The choice is remembered per browser; a play link can also pin one with `?region=<key>`. The lobby names the region and warns when the `region` or `tier` reported by `/config` does not match what the player chose. The Rules page derives its tier table from the same game module, so the two cannot drift. Replacing the static list with a server-side directory endpoint is the natural next step.

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

Configure a tier:

```bash
SLITHER_TIER=elite cargo run
```

Available environment variables:

- `SLITHER_BIND` — bind address, default `127.0.0.1:3001`
- `SLITHER_TIER` — `paper` (default), `casual`, `mid`, `standard`, `high`, or `elite`
- `SLITHER_REGION` — region key reported by `/config`, e.g. `us-east`; default `local`
- `SLITHER_ALLOWED_ORIGINS` — comma-separated site origins (e.g. `https://play.example.com`) whose pages may open `/ws` and `/bot` in addition to this server's own host and localhost
- `RUST_LOG` — tracing filter

## Production-style local run

```bash
cd web
npm run build
cd ..
cargo run --release
```

Open `http://127.0.0.1:3001`. Axum serves `web/dist` and the WebSocket from one origin.

## Deploying regions

Each region is one small Linux server (any VPS provider) running one arena per open tier behind [Caddy](https://caddyserver.com) for HTTPS. Players pick a region on the levels page; every region is an independent world. One host also serves the website; the others only need to serve their arenas (they ship the same site, which is harmless).

Example layout, with your own domain in place of `quantarena.example`:

| Host | Serves |
|---|---|
| `play.quantarena.example` | the website (point it at any one region, e.g. US East) |
| `us-east.quantarena.example` | Paper arena, US East |
| `eu-west.quantarena.example` | Paper arena, Europe |
| `ap-southeast.quantarena.example` | Paper arena, Asia-Pacific |

1. **Create the servers.** One Ubuntu 24.04 VPS per region, ideally near New York, London and Singapore (1 vCPU / 1–2 GB is plenty for Paper). Check each plan's included bandwidth: 15 updates per second per player adds up. Open only ports 22, 80 and 443 (`ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`).
2. **Point DNS** for each hostname at its server with an A/AAAA record. If you use Cloudflare, leave the arena hostnames DNS-only (grey cloud) so traffic goes straight to the region.
3. **Fill in the origins** in `web/src/games/snake/servers.ts`, e.g. `"us-east": "https://us-east.quantarena.example"`. Regions left empty are simply not offered, so you can start with one or two. (Alternatively, set `VITE_SNAKE_ORIGINS` at build time with the same JSON shape.)
4. **Build the bundle on Linux** (one of the servers, or CI), since the binary must be a Linux binary: install Rust (`curl https://sh.rustup.rs -sSf | sh`) and Node.js 24, then run `./deploy/package.sh`. It runs the tests and writes `deploy/out/slither.tar.gz`.
5. **Install on each server**: copy the bundle over, then `tar xzf slither.tar.gz && cd slither && sudo ./install.sh`. The first run creates the `slither` user, `/opt/slither`, the `slither@.service` systemd unit and example settings, then stops.
6. **Configure each server** in `/etc/slither/region.env`: `SLITHER_REGION` (the key from `servers.ts`, e.g. `eu-west`) and `SLITHER_ALLOWED_ORIGINS=https://play.quantarena.example`. Then `sudo systemctl enable --now slither@paper` and check `curl -s 127.0.0.1:3001/config`.
7. **Install Caddy** ([official instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)), copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, set your hostnames (keep the `play.` block only on the host that serves the site), and `sudo systemctl reload caddy`. Certificates are issued automatically.
8. **Check it** at `https://play.quantarena.example/#/game/snake`: the picker should show every region with a ping figure.

To upgrade, build a new bundle and run `sudo ./install.sh` again on each server. It replaces the binary and site and restarts the running arenas, which **resets their in-memory worlds**, so upgrade when few players are online. To open another tier in a region, add `/etc/slither/<tier>.env` with its own `SLITHER_BIND` port, a Caddy block for its hostname, its origin in `servers.ts`, and `systemctl enable --now slither@<tier>`.

To try two regions on one machine, run two servers on different ports and build the site against them:

```bash
SLITHER_REGION=us-east SLITHER_BIND=127.0.0.1:3001 cargo run
SLITHER_REGION=eu-west SLITHER_BIND=127.0.0.1:3002 cargo run   # second terminal
cd web && VITE_SNAKE_ORIGINS='{"paper":{"us-east":"http://127.0.0.1:3001","eu-west":"http://127.0.0.1:3002"}}' npm run build
```

Then open `http://127.0.0.1:3001/#/game/snake`.

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

Included: one in-memory arena per server, with regional deployments selectable from the levels page, human multiplayer, free live spectating, all six configurable tiers, simulated entries/payouts, a `/bot` API, treasury balls, growth, boost trails, starvation tax, collision/death, ticketed re-entry, cash-out receipts, leaderboard, deterministic placement, state resynchronization, and desktop controls.

Not included: real crypto, wallet authentication, custody/signing, persistence, bot authentication or rate limits, matchmaking, more than one arena per server process, chat, mobile controls, and audio.

The texture files under `web/public/assets` came from the supplied reference project. Verify redistribution rights before publishing publicly.

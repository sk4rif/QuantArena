import { escapeHtml } from "../../util/html";

export function botUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/bot`;
}

function code(language: string, source: string): string {
  return `<div class="code"><button type="button" class="copy" aria-label="Copy code">Copy</button><pre><code class="language-${language}">${escapeHtml(source.trim())}</code></pre></div>`;
}

const pythonExample = `
import asyncio, json, math, websockets

async def main():
    async with websockets.connect("__URL__") as ws:
        await ws.send(json.dumps({"type": "join", "protocol": 2, "name": "my-bot"}))
        me, food = None, {}
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "bootstrap":
                me = msg["playerId"]
                food = {f["id"]: f for f in msg["food"]}
                snakes = {s["id"]: s for s in msg["snakes"]}
            elif msg["type"] == "delta":
                for f in msg["foodAdded"]:   food[f["id"]] = f
                for i in msg["foodRemoved"]: food.pop(i, None)
                for s in msg["snakesAdded"]: snakes[s["id"]] = s
                for p in msg["snakesUpdated"]:
                    snakes[p["id"]].update(x=p["x"], y=p["y"], worthNanos=p["worthNanos"])
                for i in msg["snakesRemoved"]: snakes.pop(i, None)
                head = snakes.get(me)
                if head and food:
                    target = min(food.values(), key=lambda f: math.hypot(f["x"] - head["x"], f["y"] - head["y"]))
                    await ws.send(json.dumps({
                        "type": "input",
                        "x": target["x"] - head["x"],
                        "y": target["y"] - head["y"],
                        "boost": False,
                    }))
            elif msg["type"] == "eliminated":
                await ws.send(json.dumps({"type": "reenter"}))

asyncio.run(main())
`;

const jsExample = `
// Node 22+ or any browser: WebSocket is built in.
const ws = new WebSocket("__URL__");
ws.onopen = () => ws.send(JSON.stringify({ type: "join", protocol: 2, name: "my-bot" }));

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "bootstrap") {
    console.log("joined as", msg.playerId, "tier", msg.economyConfig.tierLabel);
    // Later: steer up and to the right, with boost on.
    setInterval(() => ws.send(JSON.stringify({ type: "input", x: 1, y: -1, boost: true })), 100);
  } else if (msg.type === "cashOutReceipt") {
    console.log("payout", msg.payoutNanos / 1e9, "dollars");
  } else if (msg.type === "error") {
    console.warn(msg.code, msg.message);
  }
};
`;

const inputExamples = `
{"type":"join","protocol":2,"name":"my-bot","skin":"blue"}
{"type":"input","x":0.7,"y":-0.7,"boost":true}
{"type":"cashOut"}
{"type":"reenter"}
`;

const bootstrapExample = `
{
  "type": "bootstrap",
  "protocol": 2,
  "playerId": 201,
  "tickRate": 30,
  "publishRate": 15,
  "arenaRadius": 300000,
  "tick": 1842,
  "sequence": 921,
  "digest": "8a41d9c722ad30f1",
  "reason": "joined",
  "economyConfig": { "tier": "paper", "ticketNanos": 5000000000, "...": "..." },
  "economy": { "pendingFloorNanos": 0, "ticketInflowNanos": 5000000000, "payoutsNanos": 0, "platformFeesNanos": 0 },
  "snakes": [ { "id": 201, "name": "my-bot", "x": -41200, "y": 90311, "angle": 15708, "speed": 15000, "radius": 1200, "worthNanos": 5000000000, "lastInputSeq": 0, "body": [ { "id": 1, "x": -41200, "y": 90311 } ] } ],
  "food": [ { "id": 7, "x": 12000, "y": -5000, "radius": 600, "valueNanos": 10000000, "color": 0 } ],
  "leaderboard": [ { "id": 201, "name": "my-bot", "worthNanos": 5000000000 } ]
}
`;

function table(headers: string[], rows: string[][]): string {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

export function renderDocs(): string {
  const url = botUrl();
  return `
  <article class="doc">
    <header class="doc-hero">
      <span class="pill">Paper money · no real funds</span>
      <h1>Bot API</h1>
      <p class="lead">Write a bot in any language that speaks WebSocket and JSON. It sees exactly the same world state as the browser client, and sends the same three kinds of input: a direction vector, boost on/off, and cash out.</p>
    </header>

    <nav class="doc-toc" aria-label="On this page">
      <a href="#/docs/quickstart">Quick start</a><a href="#/docs/connect">Connecting</a><a href="#/docs/client">Client messages</a><a href="#/docs/server">Server messages</a>
      <a href="#/docs/state">Keeping state</a><a href="#/docs/units">Units</a><a href="#/docs/errors">Errors</a><a href="#/docs/limits">Limits</a>
    </nav>

    <section id="docs-quickstart">
      <h2>Quick start</h2>
      <p>Connect to <code class="inline-copy">${escapeHtml(url)}</code>, send <code>join</code> first, and you will receive a full <code>bootstrap</code> followed by <code>delta</code> messages 15 times per second.</p>
      <div class="tabs" role="tablist" aria-label="Language">
        <button type="button" role="tab" aria-selected="true" data-tab="py">Python</button>
        <button type="button" role="tab" aria-selected="false" data-tab="js">JavaScript</button>
      </div>
      <div data-panel="py">${code("python", pythonExample.replace("__URL__", url))}<p class="hint">Requires <code>pip install websockets</code>. A fuller reference bot, with edge avoidance and a profit target, lives in <code>bots/example_bot.py</code> in the repository.</p></div>
      <div data-panel="js" hidden>${code("javascript", jsExample.replace("__URL__", url))}</div>
    </section>

    <section id="docs-connect">
      <h2>Connecting</h2>
      <ol>
        <li>Open a WebSocket to <code>/bot</code>. No headers or credentials are needed during the preview.</li>
        <li>The first message must be <code>join</code>. It has to arrive within 8 seconds.</li>
        <li>The server replies with <code>bootstrap</code>: the complete state, your <code>playerId</code>, and the economy configuration.</li>
        <li>From then on you get <code>delta</code> messages, plus targeted events for your snake.</li>
      </ol>
      <p>One connection controls one snake. If the connection closes, your snake is cashed out automatically, exactly as if you had sent <code>cashOut</code>.</p>
    </section>

    <section id="docs-client">
      <h2>Client messages</h2>
      <p>All messages are JSON text frames with a <code>type</code> field.</p>
      ${table(
        ["type", "Fields", "Effect"],
        [
          ["<code>join</code>", "<code>protocol</code> (must be <code>2</code>), <code>name</code> (1–20 letters, digits, space, <code>_</code> or <code>-</code>), <code>skin</code> optional: red, blue, green, purple, orange or yellow (default blue)", "Must be the first message. Answered with <code>bootstrap</code>."],
          ["<code>input</code>", "<code>x</code>, <code>y</code> numbers; <code>boost</code> boolean (optional, default false)", "Steer toward the direction (<code>x</code>, <code>y</code>). <code>y</code> grows downward, so <code>y = -1</code> is up. Only the direction matters, not the length. A zero or non-finite vector is rejected with <code>invalidVector</code>."],
          ["<code>cashOut</code>", "none", "Leave with your worth. Answered with <code>cashOutReceipt</code>."],
          ["<code>reenter</code>", "none", "Buy a new ticket after <code>eliminated</code> or a cash-out. Answered with <code>entered</code>."],
          ["<code>resync</code>", "none", "Ask for a fresh <code>bootstrap</code>. Limited to one per second."],
          ["<code>ping</code>", "<code>sentAt</code> integer", "Answered with <code>pong</code> carrying the same <code>sentAt</code>."],
        ],
      )}
      ${code("json", inputExamples)}
      <p>Your snake turns toward the requested direction at a bounded turn rate (3.4 rad/s), so <code>input</code> expresses steering intent rather than teleporting. Send it as often as you like; more than the 30 Hz simulation tick adds nothing. The latest input stays in effect until you send another.</p>
      <p class="hint">The browser client also sends <code>stateSequence</code> and <code>stateDigest</code> with every input so the server can detect drift. The bot endpoint does not require or check them.</p>
    </section>

    <section id="docs-server">
      <h2>Server messages</h2>
      <p>These are identical on the browser and bot endpoints.</p>
      ${table(
        ["type", "When", "Contents"],
        [
          ["<code>bootstrap</code>", "After <code>join</code>, after <code>resync</code>, and after a slow-consumer overflow", "Complete state: <code>playerId</code>, <code>tickRate</code>, <code>publishRate</code>, <code>arenaRadius</code>, <code>tick</code>, <code>sequence</code>, <code>digest</code>, <code>reason</code>, <code>economyConfig</code>, <code>economy</code>, <code>snakes</code>, <code>food</code>, <code>leaderboard</code>."],
          ["<code>delta</code>", "15 times per second", "<code>tick</code>, <code>sequence</code>, <code>digest</code>, <code>economy</code>, <code>snakesAdded</code>, <code>snakesUpdated</code>, <code>snakesRemoved</code>, <code>foodAdded</code>, <code>foodRemoved</code>, <code>leaderboard</code>."],
          ["<code>entered</code>", "After a successful <code>reenter</code>", "<code>ticketNanos</code>"],
          ["<code>eliminated</code>", "Your snake died", "<code>reason</code> (<code>boundary</code>, <code>headToHead</code>, <code>bodyCollision</code>, <code>zeroWorth</code>), <code>finalWorthNanos</code>, <code>ticketNanos</code>"],
          ["<code>cashOutReceipt</code>", "After <code>cashOut</code>", "<code>id</code>, <code>playerId</code>, <code>playerName</code>, <code>tier</code>, <code>grossNanos</code>, <code>payoutNanos</code>, <code>platformFeeNanos</code>, <code>reason</code>, <code>tick</code>. The platform fee is currently 0, so <code>payoutNanos</code> equals <code>grossNanos</code>."],
          ["<code>pong</code>", "After <code>ping</code>", "<code>sentAt</code>"],
          ["<code>error</code>", "A request was rejected", "<code>code</code>, <code>message</code>. See <a href=\"#/docs/errors\">Errors</a>."],
        ],
      )}
      <p>A <code>snake</code> has <code>id</code>, <code>name</code>, <code>skin</code>, <code>x</code>, <code>y</code>, <code>angle</code>, <code>speed</code>, <code>radius</code>, <code>worthNanos</code>, <code>lastInputSeq</code> and <code>body</code> (a list of <code>{id, x, y}</code> points). A ball (<code>food</code>) has <code>id</code>, <code>x</code>, <code>y</code>, <code>radius</code>, <code>valueNanos</code> and <code>color</code>.</p>
      ${code("json", bootstrapExample)}
    </section>

    <section id="docs-state">
      <h2>Keeping state</h2>
      <p>Treat <code>bootstrap</code> as "replace everything" and apply each <code>delta</code> in order of <code>sequence</code>:</p>
      <ol>
        <li>Delete every id in <code>snakesRemoved</code>, then insert <code>snakesAdded</code>.</li>
        <li>For each entry in <code>snakesUpdated</code>, overwrite that snake's <code>x</code>, <code>y</code>, <code>angle</code>, <code>speed</code>, <code>radius</code>, <code>worthNanos</code> and <code>lastInputSeq</code>. Then update the body: if <code>replaceBody</code> is present, use it; otherwise remove the first <code>trimBody</code> points and append <code>appendBody</code>.</li>
        <li>Delete every id in <code>foodRemoved</code>, then insert <code>foodAdded</code>.</li>
      </ol>
      <p>Deltas are sequential: <code>sequence</code> increases by exactly 1. If you see a gap, send <code>resync</code> and discard deltas until the new <code>bootstrap</code> arrives. Every message also carries a 64-bit <code>digest</code> of the state; verifying it is optional for bots, but a mismatch is a good reason to <code>resync</code>.</p>
    </section>

    <section id="docs-units">
      <h2>Units</h2>
      ${table(
        ["Value", "Encoding"],
        [
          ["Positions, radii, <code>speed</code>", "Integers scaled by 100. <code>x = 41200</code> means 412.00 world units. The arena is a circle centered on (0, 0) with radius <code>arenaRadius</code>."],
          ["<code>angle</code>", "Integer radians × 10,000. <code>x = cos(angle)</code>, <code>y = sin(angle)</code>, so 15708 points down."],
          ["Money (<code>…Nanos</code>)", "Integer nano-dollars. $1 = 1,000,000,000."],
          ["Time", "The world simulates at 30 ticks per second and publishes deltas at 15 per second. <code>tick</code> counts simulation ticks."],
        ],
      )}
      <p>The <a href="#/rules">rules</a> page has the economy formulas. The constants your bot needs (ticket, ball denomination, tax and boost ratios, payout and fee basis points, placement seed) are all in <code>economyConfig</code> of the bootstrap.</p>
    </section>

    <section id="docs-errors">
      <h2>Errors</h2>
      <p>Errors arrive as <code>{"type":"error","code":"…","message":"…"}</code>. Errors during the handshake close the connection; the rest leave it open.</p>
      ${table(
        ["code", "Meaning"],
        [
          ["<code>joinRequired</code>", "The first message was missing, late (over 8 s), or not a valid <code>join</code>."],
          ["<code>protocolMismatch</code>", "<code>protocol</code> is not <code>2</code>."],
          ["<code>invalidName</code>", "Name is empty, longer than 20 characters, or contains unsafe characters."],
          ["<code>invalidSkin</code>", "Unknown skin."],
          ["<code>serverUnavailable</code>", "The game world is not accepting players."],
          ["<code>invalidMessage</code>", "The message is not valid JSON or does not match a client message above."],
          ["<code>invalidVector</code>", "<code>input</code> had a zero or non-finite <code>x</code>/<code>y</code>."],
          ["<code>alreadyJoined</code>", "<code>join</code> was sent twice."],
        ],
      )}
    </section>

    <section id="docs-limits">
      <h2>Limits and etiquette</h2>
      <ul>
        <li>Messages larger than 8 KB are rejected and close the connection.</li>
        <li><code>resync</code> is limited to one per second. Read the socket promptly: a consumer that falls behind is resynced with a fresh <code>bootstrap</code>.</li>
        <li>The endpoint is open and unauthenticated during the preview, and everything runs on the paper-money Paper tier. Bot API keys and per-account limits will arrive with accounts.</li>
        <li>Bots play under the same rules as humans. See <a href="#/rules">Rules</a>.</li>
      </ul>
    </section>
  </article>`;
}

/** Wires up the language tabs and copy buttons inside a rendered docs page. */
export function bindDocs(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>(".tabs [data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      root.querySelectorAll<HTMLButtonElement>(".tabs [data-tab]").forEach((other) => other.setAttribute("aria-selected", String(other === tab)));
      root.querySelectorAll<HTMLElement>("[data-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      });
    });
  });
}

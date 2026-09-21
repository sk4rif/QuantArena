import { calculateSnakeEconomyMetrics, WorthRateTracker } from "./game/economy";
import { PointerInput } from "./game/input";
import { Replica } from "./game/replica";
import { GameSocket, type ConnectionStatus } from "./net/socket";
import { formatMoney, type CashOutReceiptMessage, type EliminatedMessage } from "./net/protocol";
import { loadAssets } from "./render/assets";
import { Renderer } from "./render/renderer";
import { Minimap } from "./render/minimap";
import { escapeHtml, requiredElement } from "./util/html";
import { isFree, type Level } from "./site/catalog";

export interface ArenaHooks {
  /** Name to prefill in the join form (the signed-in display name, or a guest default). */
  defaultName(): string;
  /** Called when the player asks to sign in from the lobby. */
  requestSignIn(): void;
  /** True when a signed-in account is active; only affects lobby wording. */
  signedIn(): boolean;
  /** The level the player chose on the level-select page, used to label the lobby. */
  level(): Level | undefined;
  /** Called when the player asks to go back to the level-select page. */
  changeLevel(): void;
}

const canvas = requiredElement<HTMLCanvasElement>("#game");
const minimapCanvas = requiredElement<HTMLCanvasElement>("#minimap");
const mapTotalAum = requiredElement<HTMLElement>("#map-total-aum");
const mapFloorCash = requiredElement<HTMLElement>("#map-floor-cash");
const hud = requiredElement<HTMLDivElement>("#hud");
const overlay = requiredElement<HTMLDivElement>("#overlay");

const replica = new Replica();
const input = new PointerInput(canvas);
const worthRateTracker = new WorthRateTracker();
let netWorthRateNanos = 0;
let renderer: Renderer | undefined;
let minimap: Minimap | undefined;
let latency = 0;
let status: ConnectionStatus = "disconnected";
let detail = "";
let hadLocalSnake = false;
let lifecycleOverlay = false;

const socket = new GameSocket(replica, {
  onState: () => {
    renderer?.reconcile();
    minimap?.render();
    const localSnake = replica.snakes.get(replica.playerId);
    netWorthRateNanos = worthRateTracker.update(replica.tick, localSnake?.worthNanos, replica.tickRate);
    const hasLocalSnake = localSnake !== undefined;
    if (hasLocalSnake && !lifecycleOverlay) hideOverlay();
    hadLocalSnake = hasLocalSnake;
    updateHud();
  },
  onStatus: (nextStatus, nextDetail = "") => {
    status = nextStatus;
    detail = nextDetail;
    updateHud();
    updateFormStatus();
  },
  onLatency: (value) => {
    latency = value;
    updateHud();
  },
  onEliminated: (message) => showElimination(message),
  onReceipt: (message) => showReceipt(message),
  onEntered: () => {
    lifecycleOverlay = false;
    hideOverlay();
  },
});

let hooks: ArenaHooks | undefined;
let serverConfig: ServerConfig | undefined;

let started = false;

interface ServerConfig {
  tier: string;
  tierLabel: string;
  ticketNanos: number;
  economyTickRate: number;
}

/** Loads assets and server config, then shows the lobby. Called the first time the arena is opened; later calls are ignored. */
export function startArena(arenaHooks: ArenaHooks): void {
  hooks = arenaHooks;
  if (started) return;
  started = true;
  start().catch((error: unknown) => {
    overlay.textContent = error instanceof Error ? error.message : "Unable to start game";
  });
}

/** True while the local player has a snake in the arena, i.e. leaving would trigger an automatic cash-out. */
export function isLive(): boolean {
  return status !== "disconnected" && replica.snakes.has(replica.playerId);
}

/** Disconnects and returns the lobby to its initial state. */
export function leaveArena(): void {
  socket.close();
  replica.snakes.clear();
  replica.food.clear();
  replica.leaderboard = [];
  replica.playerId = 0;
  status = "disconnected";
  detail = "";
  hadLocalSnake = false;
  minimap?.render();
  updateHud();
  if (serverConfig) showJoin(serverConfig);
}

/** Refreshes the lobby (e.g. after sign-in changes the default name) when it is currently shown. */
export function refreshLobby(): void {
  if (serverConfig && lifecycleOverlay && overlay.querySelector("#join-form")) showJoin(serverConfig);
}

async function start(): Promise<void> {
  const [assets, response] = await Promise.all([loadAssets(), fetch("/config")]);
  if (!response.ok) throw new Error("Unable to load server economy configuration");
  serverConfig = await response.json() as ServerConfig;
  renderer = new Renderer(canvas, replica, input.state, assets);
  minimap = new Minimap(minimapCanvas, replica);
  renderer.start();
  showJoin(serverConfig);
  updateHud();
}

function showJoin(serverConfig: ServerConfig): void {
  lifecycleOverlay = true;
  overlay.classList.remove("hidden");
  const guest = !hooks?.signedIn();
  const level = hooks?.level();
  const mismatch = level && level.key !== serverConfig.tier;
  const free = level !== undefined && isFree(level);
  // A free level still has a simulated ticket, which is what the snake starts at, so say both.
  const headline = free
    ? `Free to enter · ${formatMoney(serverConfig.ticketNanos)} simulated ticket`
    : `${serverConfig.tierLabel} tier · ${formatMoney(serverConfig.ticketNanos)} ticket`;
  overlay.innerHTML = `
    <form class="panel" id="join-form">
      <span class="pill">${escapeHtml(level?.money === "Real" ? "Simulated ledger" : "Paper money · no real funds")}</span>
      <h1>${escapeHtml(level?.label ?? serverConfig.tierLabel)}</h1>
      <p><strong>${escapeHtml(headline)}</strong><br />Entering records one ticket and starts your snake at that worth. Simulated ledger at ${serverConfig.economyTickRate} economy ticks/second. No real funds are transferred.</p>
      ${mismatch ? `<p class="notice">You chose <strong>${escapeHtml(level.label)}</strong>, but this server is running the <strong>${escapeHtml(serverConfig.tierLabel)}</strong> tier. The stake above is the one that applies.</p>` : ""}
      <label>Player name<input id="player-name" maxlength="20" value="${escapeHtml(hooks?.defaultName() ?? "Player")}" autocomplete="nickname" /></label>
      <label>Skin<select id="player-skin"><option>red</option><option>blue</option><option>green</option><option>purple</option><option>orange</option><option>yellow</option></select></label>
      <button type="submit">Enter simulated arena</button>
      <button type="button" class="link-button" id="lobby-change-level">Change level</button>
      <div class="status" id="form-status"></div>
      ${guest ? '<p class="guest-note">Playing as a guest. <button type="button" class="link-button" id="lobby-sign-in">Sign in</button> to keep your name and stats.</p>' : ""}
    </form>`;
  overlay.querySelector<HTMLButtonElement>("#lobby-sign-in")?.addEventListener("click", () => hooks?.requestSignIn());
  overlay.querySelector<HTMLButtonElement>("#lobby-change-level")?.addEventListener("click", () => hooks?.changeLevel());
  overlay.querySelector<HTMLFormElement>("#join-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    lifecycleOverlay = false;
    const name = overlay.querySelector<HTMLInputElement>("#player-name")?.value ?? "Player";
    const skin = overlay.querySelector<HTMLSelectElement>("#player-skin")?.value ?? "red";
    socket.connect(name, skin, input.state);
    updateFormStatus();
  });
}

function showElimination(message: EliminatedMessage): void {
  lifecycleOverlay = true;
  overlay.classList.remove("hidden");
  overlay.innerHTML = `
    <div class="panel">
      <h1>Eliminated</h1>
      <p>Reason: ${escapeHtml(message.reason)}. Final worth ${formatMoney(message.finalWorthNanos)} was redistributed along your body. Re-entry records a new simulated ${formatMoney(message.ticketNanos)} ticket.</p>
      <button id="reenter">Re-enter for ${formatMoney(message.ticketNanos)}</button>
    </div>`;
  overlay.querySelector<HTMLButtonElement>("#reenter")?.addEventListener("click", () => socket.reenter());
}

function showReceipt(message: CashOutReceiptMessage): void {
  lifecycleOverlay = true;
  overlay.classList.remove("hidden");
  overlay.innerHTML = `
    <div class="panel">
      <h1>Simulated receipt #${message.id}</h1>
      <p>Gross ${formatMoney(message.grossNanos)}<br />Payout ${formatMoney(message.payoutNanos)}<br />Platform fee ${formatMoney(message.platformFeeNanos)}</p>
      <button id="reenter">Re-enter for ${formatMoney(replica.economyConfig?.ticketNanos ?? 0)}</button>
    </div>`;
  overlay.querySelector<HTMLButtonElement>("#reenter")?.addEventListener("click", () => socket.reenter());
}

function hideOverlay(): void {
  overlay.classList.add("hidden");
}

function updateFormStatus(): void {
  const target = overlay.querySelector<HTMLDivElement>("#form-status");
  if (target) target.textContent = detail || (status === "connecting" ? "Connecting…" : "");
}

function updateHud(): void {
  const self = replica.snakes.get(replica.playerId);
  const tier = replica.economyConfig;
  const leaderboard = replica.leaderboard
    .map((entry) => `<li>${escapeHtml(entry.name)} — ${formatMoney(entry.worthNanos)}</li>`)
    .join("");
  const liveWorth = [...replica.snakes.values()].reduce((total, snake) => total + snake.worthNanos, 0);
  const floorWorth = [...replica.food.values()].reduce((total, ball) => total + ball.valueNanos, 0);
  mapTotalAum.textContent = formatMoney(liveWorth + floorWorth);
  mapFloorCash.textContent = formatMoney(floorWorth);
  const metrics = self && tier ? calculateSnakeEconomyMetrics(self.worthNanos, input.state.boost, tier) : undefined;
  const metricRows = metrics && self && tier ? `
    <div class="snake-metrics">
      <div><span>Starvation tax</span><strong>−${formatMoney(metrics.taxPerSecondNanos)}/s</strong></div>
      <div><span>Boost rate</span><strong>−${formatMoney(metrics.boostPerSecondNanos)}/s</strong></div>
      <div><span>Current burn</span><strong>−${formatMoney(metrics.currentBurnPerSecondNanos)}/s</strong></div>
      <div><span>Net worth Δ</span><strong class="${netWorthRateNanos > 0 ? "metric-positive" : netWorthRateNanos < 0 ? "metric-negative" : ""}">${formatSignedRate(netWorthRateNanos)}</strong></div>
      <div><span>Cash-out value</span><strong class="metric-money">${formatMoney(metrics.cashOutValueNanos)}</strong></div>
    </div>` : "";
  hud.innerHTML = `
    <div class="hud-card">${tier ? `<strong>${escapeHtml(tier.tierLabel)}</strong> · ${formatMoney(tier.ticketNanos)} ticket<br />` : ""}Net profit <strong class="${self && tier ? (self.worthNanos >= tier.ticketNanos ? "metric-positive" : "metric-negative") : ""}">${self && tier ? formatSignedMoney(self.worthNanos - tier.ticketNanos) : "+$0.00"}</strong>${metricRows}<br />${latency} ms · ${status}${detail ? `<br />${escapeHtml(detail)}` : ""}${self ? `<button class="hud-action" id="cash-out">Cash out ${formatMoney(metrics?.cashOutValueNanos ?? self.worthNanos)}</button>` : ""}</div>
    <div class="hud-card"><strong>Leaderboard</strong><ol class="leaderboard">${leaderboard}</ol></div>`;
  hud.querySelector<HTMLButtonElement>("#cash-out")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!self) return;
    const payout = metrics?.cashOutValueNanos ?? self.worthNanos;
    if (window.confirm(`Cash out ${formatMoney(self.worthNanos)}? Simulated payout: ${formatMoney(payout)}.`)) {
      socket.cashOut();
    }
  });
}

function formatSignedMoney(nanos: number): string {
  const prefix = nanos > 0 ? "+" : nanos < 0 ? "−" : "";
  return `${prefix}${formatMoney(Math.abs(nanos))}`;
}

function formatSignedRate(nanosPerSecond: number): string {
  return `${formatSignedMoney(nanosPerSecond)}/s`;
}

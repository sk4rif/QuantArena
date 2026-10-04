import { calculateSnakeEconomyMetrics, WorthRateTracker } from "./game/economy";
import { PointerInput } from "./game/input";
import { Replica } from "./game/replica";
import { GameSocket, type ConnectionStatus } from "./net/socket";
import { formatMoney, type CashOutReceiptMessage, type EliminatedMessage } from "./net/protocol";
import { loadAssets } from "./render/assets";
import { Renderer } from "./render/renderer";
import { Minimap } from "./render/minimap";
import { escapeHtml } from "../../util/html";
import { isFree, type ArenaHooks } from "../types";
import {
  actionConfirmation,
  actionConfirmationAccept,
  actionConfirmationCancel,
  actionConfirmationMessage,
  actionConfirmationTitle,
  canvas,
  hud,
  mapFloorCash,
  mapTotalAum,
  minimapCanvas,
  overlay,
} from "./view";

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
let spectating = false;
let confirmationResolve: ((confirmed: boolean) => void) | undefined;

const socket = new GameSocket(replica, {
  onState: () => {
    renderer?.reconcile();
    minimap?.render();
    const localSnake = replica.snakes.get(replica.playerId);
    netWorthRateNanos = worthRateTracker.update(replica.tick, localSnake?.worthNanos, replica.tickRate);
    const hasLocalSnake = localSnake !== undefined;
    if ((hasLocalSnake || spectating) && !lifecycleOverlay) hideOverlay();
    hadLocalSnake = hasLocalSnake;
    updateHud();
  },
  onPickup: (valueNanos) => renderer?.showPickup(valueNanos),
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

actionConfirmationCancel.addEventListener("click", () => finishConfirmation(false));
actionConfirmationAccept.addEventListener("click", () => finishConfirmation(true));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && confirmationResolve) {
    finishConfirmation(false);
    return;
  }
  const target = event.target;
  const editing = target instanceof HTMLElement
    && (target.isContentEditable || target.matches("input, textarea, select"));
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || editing || confirmationResolve || !isLive()) return;
  const cashOutPending = replica.cashOutCompletesAtTick !== undefined;
  if (event.code === "KeyC" && !cashOutPending) socket.cashOut();
  else if (event.code === "KeyX" && cashOutPending) socket.cancelCashOut();
  else return;
  event.preventDefault();
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

/** True while the local player has a snake in the arena, i.e. leaving would abandon it. */
export function isLive(): boolean {
  return status !== "disconnected" && replica.snakes.has(replica.playerId);
}

export function confirmArenaAction(title: string, message: string, acceptLabel: string): Promise<boolean> {
  finishConfirmation(false);
  actionConfirmationTitle.textContent = title;
  actionConfirmationMessage.textContent = message;
  actionConfirmationAccept.textContent = acceptLabel;
  actionConfirmation.classList.remove("hidden");
  window.requestAnimationFrame(() => actionConfirmationCancel.focus());
  return new Promise((resolve) => {
    confirmationResolve = resolve;
  });
}

/** Disconnects and returns the lobby to its initial state. */
export function leaveArena(): void {
  finishConfirmation(false);
  socket.close();
  replica.snakes.clear();
  replica.food.clear();
  replica.leaderboard = [];
  replica.cashOutCompletesAtTick = undefined;
  replica.playerId = 0;
  status = "disconnected";
  detail = "";
  hadLocalSnake = false;
  spectating = false;
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
  const accountName = hooks?.accountName() ?? "";
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
      <label>Player name<input id="player-name" value="${escapeHtml(accountName)}" placeholder="Player" autocomplete="nickname" readonly /></label>
      <button type="submit">Enter simulated arena</button>
      <button type="button" class="spectate-button" id="spectate-arena">Spectate live arena</button>
      <button type="button" class="link-button" id="lobby-change-level">Change level</button>
      <div class="status" id="form-status"></div>
      ${guest ? '<p class="guest-note">Playing as a guest. <button type="button" class="link-button" id="lobby-sign-in">Sign in</button> to keep your name and stats.</p>' : ""}
    </form>`;
  overlay.querySelector<HTMLButtonElement>("#lobby-sign-in")?.addEventListener("click", () => hooks?.requestSignIn());
  overlay.querySelector<HTMLButtonElement>("#lobby-change-level")?.addEventListener("click", () => hooks?.changeLevel());
  overlay.querySelector<HTMLButtonElement>("#spectate-arena")?.addEventListener("click", () => connectToArena(true));
  overlay.querySelector<HTMLFormElement>("#join-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    connectToArena(false);
  });
}

function connectToArena(asSpectator: boolean): void {
  lifecycleOverlay = false;
  spectating = asSpectator;
  const name = hooks?.accountName()?.trim() || "Player";
  socket.connect(name, "red", input.state, asSpectator);
  updateFormStatus();
  updateHud();
}

function showElimination(message: EliminatedMessage): void {
  finishConfirmation(false);
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
  finishConfirmation(false);
  lifecycleOverlay = true;
  overlay.classList.remove("hidden");
  const ticketNanos = replica.economyConfig?.ticketNanos ?? 0;
  const netProfitNanos = message.payoutNanos - ticketNanos;
  overlay.innerHTML = `
    <div class="receipt-confetti" aria-hidden="true">${confettiPieces()}</div>
    <div class="panel receipt-panel">
      <h1>Simulated receipt #${message.id}</h1>
      <div class="receipt-summary">
        <div><span>Gross</span><strong>${formatMoney(message.grossNanos)}</strong></div>
        <div><span>Platform fee</span><strong>${formatMoney(message.platformFeeNanos)}</strong></div>
        <div><span>Payout</span><strong>${formatMoney(message.payoutNanos)}</strong></div>
        <div class="receipt-profit"><span>Net profit</span><strong class="${netProfitNanos >= 0 ? "metric-positive" : "metric-negative"}">${formatSignedMoney(netProfitNanos)}</strong></div>
      </div>
      <button id="reenter">Re-enter for ${formatMoney(ticketNanos)}</button>
    </div>`;
  overlay.querySelector<HTMLButtonElement>("#reenter")?.addEventListener("click", () => socket.reenter());
}

function confettiPieces(): string {
  const colors = ["#dc4325", "#f59e0b", "#15803d", "#2563eb", "#9333ea", "#fb6242"];
  return Array.from({ length: 56 }, (_, index) => {
    const angle = index / 56 * Math.PI * 2 + (index % 5 - 2) * 0.035;
    const distance = 150 + index % 9 * 17;
    const burstX = Math.cos(angle) * distance;
    const burstY = Math.sin(angle) * distance - 30;
    const fallX = burstX * 1.18;
    const fallY = burstY + 210 + index % 4 * 24;
    const delay = index % 8 * 0.018;
    const duration = 1.25 + index % 7 * 0.07;
    const spin = 420 + index % 9 * 85;
    const color = colors[index % colors.length];
    return `<i style="--confetti-delay: ${delay.toFixed(3)}s; --confetti-duration: ${duration.toFixed(2)}s; --confetti-burst-x: ${burstX.toFixed(1)}px; --confetti-burst-y: ${burstY.toFixed(1)}px; --confetti-fall-x: ${fallX.toFixed(1)}px; --confetti-fall-y: ${fallY.toFixed(1)}px; --confetti-spin: ${spin}deg; --confetti-fall-spin: ${spin + 420}deg; --confetti-color: ${color}"></i>`;
  }).join("");
}

function hideOverlay(): void {
  overlay.classList.add("hidden");
}

function finishConfirmation(confirmed: boolean): void {
  const resolve = confirmationResolve;
  if (!resolve) return;
  confirmationResolve = undefined;
  actionConfirmation.classList.add("hidden");
  resolve(confirmed);
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
  const cashOutDeadline = self ? replica.cashOutCompletesAtTick : undefined;
  const cashOutTicks = cashOutDeadline === undefined ? undefined : Math.max(0, cashOutDeadline - replica.tick);
  const cashOutSeconds = cashOutTicks === undefined ? undefined : cashOutTicks / replica.tickRate;
  const cashOutProgress = cashOutTicks === undefined
    ? 0
    : Math.min(1, cashOutTicks / (tier?.cashOutDelayTicks ?? replica.tickRate * 10));
  const cashOutPulse = cashOutSeconds === undefined
    ? 1
    : 1 + Math.sin(replica.tick / replica.tickRate * Math.PI * (cashOutSeconds <= 3 ? 8 : 2.5)) * 0.025;
  const cashOutStatus = cashOutSeconds === undefined
    ? ""
    : `<div class="cashout-countdown${cashOutSeconds <= 3 ? " urgent" : ""}" role="timer" aria-label="Cash out in ${cashOutSeconds.toFixed(1)} seconds" style="--cashout-progress: ${(cashOutProgress * 360).toFixed(2)}deg; --cashout-pulse: ${cashOutPulse.toFixed(3)}">
        <div class="cashout-ring"><div><strong>${cashOutSeconds.toFixed(1)}</strong><span>seconds</span></div></div>
        <div class="cashout-copy"><strong>Cashing out</strong><span>Stay alive · <kbd>X</kbd> cancel</span></div>
      </div>`;
  let cashOutAction = "";
  if (self) {
    cashOutAction = cashOutDeadline === undefined
      ? `<button class="hud-action" id="cash-out" aria-keyshortcuts="C"><span>Cash out ${formatMoney(metrics?.cashOutValueNanos ?? self.worthNanos)}</span><kbd>C</kbd></button>`
      : `<button class="hud-action cashout-cancel" id="cash-out" aria-keyshortcuts="X"><span>Cancel cash out</span><kbd>X</kbd></button>`;
  }
  const metricRows = metrics && self && tier ? `
    <div class="snake-metrics">
      <div><span>Starvation tax</span><strong>−${formatMoney(metrics.taxPerSecondNanos)}/s</strong></div>
      <div><span>Boost rate</span><strong>−${formatMoney(metrics.boostPerSecondNanos)}/s</strong></div>
      <div><span>Current burn</span><strong>−${formatMoney(metrics.currentBurnPerSecondNanos)}/s</strong></div>
      <div><span>Net worth Δ</span><strong class="${netWorthRateNanos > 0 ? "metric-positive" : netWorthRateNanos < 0 ? "metric-negative" : ""}">${formatSignedRate(netWorthRateNanos)}</strong></div>
      <div><span>Cash-out value</span><strong class="metric-money">${formatMoney(metrics.cashOutValueNanos)}</strong></div>
    </div>` : "";
  const playerCard = spectating && !self
    ? `<div class="hud-card spectator-card"><span class="spectator-badge">Live spectator</span><strong>Watching the arena</strong><span>${latency} ms · ${status}${detail ? `<br />${escapeHtml(detail)}` : ""}</span><button class="hud-action" id="enter-arena">Enter simulated arena</button></div>`
    : `<div class="hud-card">${tier ? `<strong>${escapeHtml(tier.tierLabel)}</strong> · ${formatMoney(tier.ticketNanos)} ticket<br />` : ""}Net profit <strong class="${self && tier ? (self.worthNanos >= tier.ticketNanos ? "metric-positive" : "metric-negative") : ""}">${self && tier ? formatSignedMoney(self.worthNanos - tier.ticketNanos) : "+$0.00"}</strong>${metricRows}<br />${latency} ms · ${status}${detail ? `<br />${escapeHtml(detail)}` : ""}${cashOutAction}</div>`;
  hud.innerHTML = `
    ${cashOutStatus}
    ${playerCard}
    <div class="hud-card"><strong>Leaderboard</strong><ol class="leaderboard">${leaderboard}</ol></div>`;
  hud.querySelector<HTMLButtonElement>("#enter-arena")?.addEventListener("click", () => connectToArena(false));
  hud.querySelector<HTMLButtonElement>("#cash-out")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!self) return;
    if (cashOutDeadline !== undefined) {
      socket.cancelCashOut();
      return;
    }
    socket.cashOut();
  });
}

function formatSignedMoney(nanos: number): string {
  const prefix = nanos > 0 ? "+" : nanos < 0 ? "−" : "";
  return `${prefix}${formatMoney(Math.abs(nanos))}`;
}

function formatSignedRate(nanosPerSecond: number): string {
  return `${formatSignedMoney(nanosPerSecond)}/s`;
}

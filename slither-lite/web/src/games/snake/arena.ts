import { calculateSnakeEconomyMetrics, WorthRateTracker } from "./game/economy";
import { PointerInput } from "./game/input";
import { Replica } from "./game/replica";
import { GameSocket, type ConnectionStatus } from "./net/socket";
import { formatMoney, type CashOutReceiptMessage, type EliminatedMessage } from "./net/protocol";
import { Renderer } from "./render/renderer";
import { Minimap } from "./render/minimap";
import { escapeHtml } from "../../util/html";
import { endpointUrl, LOCAL_REGION } from "../regions";
import { isFree, type ArenaHooks, type LevelServer } from "../types";
import {
  actionConfirmation,
  actionConfirmationAccept,
  actionConfirmationCancel,
  actionConfirmationMessage,
  actionConfirmationTitle,
  canvas,
  hud,
  mapFloorCash,
  mapFloorCashRatio,
  mapPendingFloor,
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
let economyDetailsExpanded = false;
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
  onFoodAdded: (items) => renderer?.showFoodSpawns(items),
  onPickup: (valueNanos, items) => renderer?.showPickup(valueNanos, items),
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
/** The arena `serverConfig` came from; the socket always connects to this one. */
let currentServer: LevelServer | undefined;
/** Bumped by every start and leave, so a slow region lookup or config fetch cannot act after the player moved on. */
let startAttempt = 0;

interface ServerConfig {
  /** Absent on servers that predate regions. */
  region?: string;
  tier: string;
  tierLabel: string;
  ticketNanos: number;
  economyTickRate: number;
}

/** Picks the arena (level and region), loads its config when it changed, then connects in the mode selected on the level page. */
export function startArena(arenaHooks: ArenaHooks): void {
  hooks = arenaHooks;
  const attempt = ++startAttempt;
  start(attempt).catch((error: unknown) => {
    if (attempt !== startAttempt) return;
    lifecycleOverlay = true;
    overlay.classList.remove("hidden");
    overlay.innerHTML = `
      <div class="panel">
        <h1>Arena unavailable</h1>
        <p>${escapeHtml(error instanceof Error ? error.message : "Unable to start game")}</p>
        <button type="button" id="lobby-change-level">Choose another level or region</button>
      </div>`;
    overlay.querySelector<HTMLButtonElement>("#lobby-change-level")?.addEventListener("click", () => hooks?.changeLevel());
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
  startAttempt += 1;
  finishConfirmation(false);
  socket.close();
  clearReplica();
  status = "disconnected";
  detail = "";
  hadLocalSnake = false;
  spectating = false;
  input.setPanningEnabled(false);
  minimap?.setNavigationEnabled(false);
  minimap?.render();
  updateHud();
  if (serverConfig) showJoin(serverConfig);
}

/** Refreshes the lobby (e.g. after sign-in changes the default name) when it is currently shown. */
export function refreshLobby(): void {
  if (serverConfig && lifecycleOverlay && overlay.querySelector("#join-form")) showJoin(serverConfig);
}

async function start(attempt: number): Promise<void> {
  const server = await hooks?.server() ?? { region: LOCAL_REGION, origin: "" };
  if (attempt !== startAttempt) return;
  if (!serverConfig || currentServer?.origin !== server.origin) {
    // A different region or level is a different world: drop the old one before showing the new one.
    socket.close();
    status = "disconnected";
    detail = "";
    latency = 0;
    replica.forgetWorld();
    renderer?.reconcile();
    minimap?.render();
    updateHud();
    serverConfig = undefined;
    currentServer = server;
    showConnecting(server);
    serverConfig = await loadServerConfig(server);
    if (attempt !== startAttempt) return;
  }
  if (!renderer) {
    renderer = new Renderer(canvas, replica, input.state);
    minimap = new Minimap(minimapCanvas, replica, (point) => renderer?.moveCamera(point.x, point.y));
    renderer.start();
  }
  showJoin(serverConfig);
  updateHud();
  if (status === "disconnected") connectToArena(hooks?.startAsSpectator() ?? false);
}

async function loadServerConfig(server: LevelServer): Promise<ServerConfig> {
  const where = server.region.key === LOCAL_REGION.key ? "the game server" : `the ${server.region.label} server`;
  let response: Response;
  try {
    response = await fetch(endpointUrl(server.origin, "/config"), { cache: "no-store" });
  } catch {
    throw new Error(`Could not reach ${where}. It may be down; try another region.`);
  }
  if (!response.ok) throw new Error(`Unable to load the economy configuration from ${where}.`);
  return await response.json() as ServerConfig;
}

function showConnecting(server: LevelServer): void {
  lifecycleOverlay = true;
  overlay.classList.remove("hidden");
  const where = server.region.key === LOCAL_REGION.key ? "" : ` to ${escapeHtml(server.region.label)}`;
  overlay.innerHTML = `<div class="panel"><h1>Connecting${where}…</h1></div>`;
}

function clearReplica(): void {
  replica.snakes.clear();
  replica.food.clear();
  renderer?.reconcile();
  replica.leaderboard = [];
  replica.cashOutCompletesAtTick = undefined;
  replica.cashOutInheritanceTaxBasisPoints = undefined;
  replica.playerId = 0;
}

function showJoin(serverConfig: ServerConfig): void {
  lifecycleOverlay = true;
  overlay.classList.remove("hidden");
  const guest = !hooks?.signedIn();
  const accountName = hooks?.accountName() ?? "";
  const level = hooks?.level();
  const mismatch = level && level.key !== serverConfig.tier;
  const region = currentServer && currentServer.region.key !== LOCAL_REGION.key ? currentServer.region : undefined;
  // Only flagged when the server says which region it is; a mismatch means a deployment points at the wrong host.
  const regionMismatch = region && serverConfig.region !== undefined && serverConfig.region !== region.key;
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
      ${region ? `<p class="region-line">Region <strong>${escapeHtml(region.label)}</strong>${region.location ? ` · ${escapeHtml(region.location)}` : ""}</p>` : ""}
      ${regionMismatch ? `<p class="notice">You chose the <strong>${escapeHtml(region.label)}</strong> region, but this server reports <strong>${escapeHtml(serverConfig.region ?? "")}</strong>. Check its <code>SLITHER_REGION</code> setting.</p>` : ""}
      ${mismatch ? `<p class="notice">You chose <strong>${escapeHtml(level.label)}</strong>, but this server is running the <strong>${escapeHtml(serverConfig.tierLabel)}</strong> tier. The stake above is the one that applies.</p>` : ""}
      <label>Player name<input id="player-name" value="${escapeHtml(accountName)}" placeholder="Player" autocomplete="nickname" readonly /></label>
      <button type="submit">Enter simulated arena</button>
      <button type="button" class="spectate-button" id="spectate-arena">Spectate live arena</button>
      <button type="button" class="link-button" id="lobby-change-level">${region ? "Change level or region" : "Change level"}</button>
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
  input.setPanningEnabled(asSpectator);
  minimap?.setNavigationEnabled(asSpectator);
  economyDetailsExpanded = false;
  const name = hooks?.accountName()?.trim() || "Player";
  socket.connect(endpointUrl(currentServer?.origin ?? "", "/ws", "ws"), name, "red", input.state, asSpectator);
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
      ${message.collisionId == null ? "" : `<p>Collision reference <strong>#${message.collisionId}</strong></p>`}
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
      <h1>Simulated receipt</h1>
      <div class="receipt-summary">
        <div><span>Gross worth</span><strong>${formatMoney(message.grossNanos)}</strong></div>
        <div><span>Returned to the game: inheritance tax (${formatBasisPoints(message.inheritanceTaxBasisPoints)})</span><strong>−${formatMoney(message.inheritanceTaxNanos)}</strong></div>
        <div><span>Voided: 2% platform fee</span><strong>−${formatMoney(message.platformFeeNanos)}</strong></div>
        <div><span>Final payout</span><strong>${formatMoney(message.payoutNanos)}</strong></div>
        <div class="receipt-profit"><span>Net profit</span><strong class="${netProfitNanos >= 0 ? "metric-positive" : "metric-negative"}">${formatSignedMoney(netProfitNanos)}</strong></div>
      </div>
      <p class="receipt-details"><strong>Only the platform fee is voided.</strong> The full inheritance tax is returned to the game as collectible floor money; none of it goes to the platform.</p>
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
  const pendingFloor = replica.economy.pendingFloorNanos;
  const totalAum = liveWorth + floorWorth + pendingFloor;
  mapTotalAum.textContent = formatMoney(totalAum);
  mapFloorCash.textContent = formatMoney(floorWorth);
  mapPendingFloor.textContent = formatMoney(pendingFloor);
  mapFloorCashRatio.textContent = `${(replica.economy.floorLiquidityRatioPpm / 10_000).toFixed(1)}%`;
  const cashOutDeadline = self ? replica.cashOutCompletesAtTick : undefined;
  const inheritanceTaxBasisPoints = cashOutDeadline === undefined
    ? replica.economy.inheritanceTaxBasisPoints
    : replica.cashOutInheritanceTaxBasisPoints ?? replica.economy.inheritanceTaxBasisPoints;
  const metrics = self && tier
    ? calculateSnakeEconomyMetrics(self.worthNanos, input.state.boost, tier, {
        ...replica.economy,
        inheritanceTaxBasisPoints,
      })
    : undefined;
  const grossProfitNanos = self && tier ? self.worthNanos - tier.ticketNanos : 0;
  const netProfitNanos = metrics && tier ? metrics.cashOutValueNanos - tier.ticketNanos : 0;
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
        <div class="cashout-copy"><strong>Cash out ${formatMoney(metrics?.cashOutValueNanos ?? self?.worthNanos ?? 0)}</strong><span>Locked ${formatBasisPoints(metrics?.inheritanceTaxBasisPoints ?? 0)} returned to game · ${formatBasisPoints(tier?.platformFeeBasisPoints ?? 0)} voided · <kbd>X</kbd> cancel</span></div>
      </div>`;
  let cashOutAction = "";
  if (self) {
    cashOutAction = cashOutDeadline === undefined
      ? `<button class="hud-action" id="cash-out" aria-keyshortcuts="C"><span>Cash out ${formatMoney(metrics?.cashOutValueNanos ?? self.worthNanos)}</span><kbd>C</kbd></button>`
      : `<button class="hud-action cashout-cancel" id="cash-out" aria-keyshortcuts="X"><span>Cancel cash out</span><kbd>X</kbd></button>`;
  }
  const metricRows = metrics && self && tier ? `
    <div class="snake-metrics">
      ${economyDetailsExpanded ? `
        <div class="metric-heading"><span>Player economics</span><strong>Live</strong></div>
        <div><span>Current worth</span><strong class="metric-money">${formatMoney(self.worthNanos)}</strong></div>
        <div><span>Gross P&amp;L before exit tax</span><strong class="${grossProfitNanos >= 0 ? "metric-positive" : "metric-negative"}">${formatSignedMoney(grossProfitNanos)}</strong></div>
        <div><span>Net P&amp;L after exit tax</span><strong class="${netProfitNanos >= 0 ? "metric-positive" : "metric-negative"}">${formatSignedMoney(netProfitNanos)}</strong></div>
        <div><span>Starvation per tick</span><strong>−${formatMoney(metrics.taxPerTickNanos)}</strong></div>
        <div><span>Starvation per second</span><strong>−${formatMoney(metrics.taxPerSecondNanos)}/s</strong></div>
        <div><span>Worth half-life at this rate</span><strong>${formatDuration(metrics.starvationHalfLifeSeconds)}</strong></div>
        <div><span>Boost rate</span><strong>−${formatMoney(metrics.boostPerSecondNanos)}/s</strong></div>
        <div><span>Current burn</span><strong>−${formatMoney(metrics.currentBurnPerSecondNanos)}/s</strong></div>
        <div><span>Net worth Δ</span><strong class="${netWorthRateNanos > 0 ? "metric-positive" : netWorthRateNanos < 0 ? "metric-negative" : ""}">${formatSignedRate(netWorthRateNanos)}</strong></div>
        <div class="metric-heading"><span>Tax regime math</span><strong>${formatPpm(metrics.floorLiquidityRatioPpm)}</strong></div>
        <div class="metric-formula"><span>r = (floor + pending) / total AUM</span><strong>${formatPpm(metrics.floorLiquidityRatioPpm)}</strong></div>
        <div class="metric-formula"><span>q = smoothstep(clamp((r − ${formatPpm(tier.liquidityRatioLowPpm)}) / ${formatPpm(tier.liquidityRatioHighPpm - tier.liquidityRatioLowPpm)}))</span><strong>${(metrics.regimePosition * 100).toFixed(1)}%</strong></div>
        <div class="metric-formula"><span>S = ${tier.starvationMaxNumerator.toLocaleString()} − (${tier.starvationMaxNumerator.toLocaleString()} − ${tier.starvationMinNumerator.toLocaleString()}) × q</span><strong>${replica.economy.starvationTaxNumerator.toLocaleString()} / ${tier.starvationDenominator.toLocaleString()}</strong></div>
        <div class="metric-formula"><span>I = ${formatBasisPoints(tier.inheritanceTaxMaxBasisPoints)} − (${formatBasisPoints(tier.inheritanceTaxMaxBasisPoints)} − ${formatBasisPoints(tier.inheritanceTaxMinBasisPoints)}) × q</span><strong>${formatBasisPoints(metrics.inheritanceTaxBasisPoints)}</strong></div>
        <div class="metric-heading"><span>Cash-out breakdown</span><strong>${formatMoney(metrics.cashOutValueNanos)}</strong></div>
        <div><span>Gross worth</span><strong>${formatMoney(metrics.grossCashOutNanos)}</strong></div>
        <div><span>Returned to game: inheritance (${formatBasisPoints(metrics.inheritanceTaxBasisPoints)})</span><strong class="metric-negative">−${formatMoney(metrics.inheritanceTaxNanos)}</strong></div>
        <div><span>Voided: platform fee (${formatBasisPoints(tier.platformFeeBasisPoints)})</span><strong class="metric-negative">−${formatMoney(metrics.platformFeeNanos)}</strong></div>
        <div><span>Cash-out value</span><strong class="metric-money">${formatMoney(metrics.cashOutValueNanos)}</strong></div>
      ` : `
        <div><span>Gross worth</span><strong class="metric-money">${formatMoney(metrics.grossCashOutNanos)}</strong></div>
        <div><span>Starvation per second</span><strong>−${formatMoney(metrics.taxPerSecondNanos)}/s</strong></div>
        <div><span>Worth half-life</span><strong>${formatDuration(metrics.starvationHalfLifeSeconds)}</strong></div>
        <div><span>Boost rate</span><strong>−${formatMoney(metrics.boostPerSecondNanos)}/s</strong></div>
        <div><span>Net worth Δ</span><strong class="${netWorthRateNanos > 0 ? "metric-positive" : netWorthRateNanos < 0 ? "metric-negative" : ""}">${formatSignedRate(netWorthRateNanos)}</strong></div>
        <div><span>Returned to game (${formatBasisPoints(metrics.inheritanceTaxBasisPoints)})</span><strong class="metric-negative">−${formatMoney(metrics.inheritanceTaxNanos)}</strong></div>
        <div><span>Voided platform fee (${formatBasisPoints(tier.platformFeeBasisPoints)})</span><strong class="metric-negative">−${formatMoney(metrics.platformFeeNanos)}</strong></div>
        <div><span>Cash-out value</span><strong class="metric-money">${formatMoney(metrics.cashOutValueNanos)}</strong></div>
      `}
    </div>
    <button type="button" class="economy-details-toggle" id="economy-details">${economyDetailsExpanded ? "Less details" : "More details"}</button>` : "";
  const playerCard = spectating && !self
    ? `<div class="hud-card spectator-card"><span class="spectator-badge">Live spectator</span><strong>Watching the arena</strong><span>Use arrow keys, screen edges, or click the minimap to explore<br />${latency} ms · ${status}${detail ? `<br />${escapeHtml(detail)}` : ""}</span><button class="hud-action" id="enter-arena">Enter simulated arena</button></div>`
    : `<div class="hud-card player-economy-card${economyDetailsExpanded ? " expanded" : ""}">${tier ? `<strong>${escapeHtml(tier.tierLabel)}</strong> · ${formatMoney(tier.ticketNanos)} ticket<br />` : ""}Net profit <strong class="${self && metrics ? (netProfitNanos >= 0 ? "metric-positive" : "metric-negative") : ""}">${self && metrics ? formatSignedMoney(netProfitNanos) : "+$0.00"}</strong>${metricRows}<br />${latency} ms · ${status}${detail ? `<br />${escapeHtml(detail)}` : ""}${cashOutAction}</div>`;
  hud.innerHTML = `
    ${cashOutStatus}
    ${playerCard}
    <div class="hud-card"><strong>Leaderboard</strong><ol class="leaderboard">${leaderboard}</ol></div>`;
  hud.querySelector<HTMLButtonElement>("#enter-arena")?.addEventListener("click", () => connectToArena(false));
  hud.querySelector<HTMLButtonElement>("#economy-details")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    economyDetailsExpanded = !economyDetailsExpanded;
    updateHud();
  });
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

function formatBasisPoints(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

function formatPpm(partsPerMillion: number): string {
  return `${(partsPerMillion / 10_000).toFixed(1)}%`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  return `${(seconds / 60).toFixed(1)} min`;
}

function formatSignedMoney(nanos: number): string {
  const prefix = nanos > 0 ? "+" : nanos < 0 ? "−" : "";
  return `${prefix}${formatMoney(Math.abs(nanos))}`;
}

function formatSignedRate(nanosPerSecond: number): string {
  return `${formatSignedMoney(nanosPerSecond)}/s`;
}

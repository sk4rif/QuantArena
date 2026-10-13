import { AUTO_REGION, gameRegions, loadRegionPreference, pingRegions, regionLatencies, saveRegionPreference } from "../games/regions";
import type { GameModule, Region } from "../games/types";
import { escapeHtml } from "../util/html";

/**
 * Region choice for a game's levels page. Rendered only when the game runs in more than one
 * region; a single-server setup shows nothing and behaves exactly as before.
 */
export function renderRegionPicker(game: Pick<GameModule, "levels">): string {
  const regions = gameRegions(game);
  if (regions.length < 2) return "";
  return `
    <section id="levels-region" class="region-picker">
      <h2>Server region</h2>
      <p class="hint">Every region runs its own arena, with its own players, floor cash and leaderboard. Pick the one closest to you for the lowest lag, or let Auto choose by ping.</p>
      <div class="region-options" role="radiogroup" aria-label="Server region">
        <label class="region-option">
          <input type="radio" name="region" value="${AUTO_REGION}" />
          <span class="region-name">Auto</span>
          <span class="region-meta" data-region-auto>Measuring ping…</span>
        </label>
        ${regions.map(regionOption).join("")}
      </div>
    </section>`;
}

function regionOption(region: Region): string {
  const key = escapeHtml(region.key);
  return `
        <label class="region-option">
          <input type="radio" name="region" value="${key}" />
          <span class="region-name">${escapeHtml(region.label)}</span>
          <span class="region-meta">${region.location ? `${escapeHtml(region.location)} · ` : ""}<span class="region-ping" data-region-ping="${key}">…</span></span>
        </label>`;
}

/** Restores the saved choice, saves changes, and fills in live ping figures. */
export function bindRegionPicker(root: HTMLElement, game: Pick<GameModule, "id" | "levels">): void {
  const picker = root.querySelector<HTMLElement>("#levels-region");
  if (!picker) return;
  const regions = gameRegions(game);
  const saved = loadRegionPreference(game.id);
  const initial = regions.some((region) => region.key === saved) ? saved : AUTO_REGION;
  const inputs = [...picker.querySelectorAll<HTMLInputElement>('input[name="region"]')];
  for (const input of inputs) input.checked = input.value === initial;
  picker.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === "region" && input.checked) saveRegionPreference(game.id, input.value);
  });

  const measured = new Set<string>();
  const update = (regionKey: string, latency: number | undefined): void => {
    measured.add(regionKey);
    const target = picker.querySelector<HTMLElement>(`[data-region-ping="${CSS.escape(regionKey)}"]`);
    if (target) {
      target.textContent = latency === undefined ? "unreachable" : `${latency} ms`;
      target.dataset.quality = latency === undefined ? "down" : latency < 90 ? "good" : latency < 180 ? "fair" : "poor";
    }
    const auto = picker.querySelector<HTMLElement>("[data-region-auto]");
    if (!auto) return;
    const best = fastest(regions);
    if (best) auto.textContent = `${best.region.label} · ${best.latency} ms`;
    else if (measured.size === regions.length) auto.textContent = "No region reachable";
  };
  void pingRegions(game, update, true);
}

function fastest(regions: readonly Region[]): { region: Region; latency: number } | undefined {
  let best: { region: Region; latency: number } | undefined;
  for (const region of regions) {
    const latency = regionLatencies.get(region.key);
    if (latency !== undefined && (!best || latency < best.latency)) best = { region, latency };
  }
  return best;
}

import { requiredElement } from "../../util/html";

const root = requiredElement<HTMLElement>("#view-play");
root.setAttribute("aria-label", "Arena");
root.innerHTML = `
  <canvas id="game"></canvas>
  <div id="hud"></div>
  <aside id="minimap-panel" aria-label="Arena minimap">
    <div class="minimap-title">Arena overview</div>
    <canvas id="minimap"></canvas>
    <div class="minimap-legend"><span></span> Dollar-value density · Red: snakes · Dark outline: you · Pink ⌖: money spawn (lowest AUM weight)</div>
    <div class="minimap-metrics">
      <div><span>Total AUM</span><strong id="map-total-aum">$0.00</strong></div>
      <div><span>Cash on floor</span><strong id="map-floor-cash">$0.00</strong></div>
    </div>
  </aside>
  <div id="overlay"></div>
  <div id="action-confirmation" class="hidden" role="alertdialog" aria-modal="true" aria-labelledby="action-confirmation-title" aria-describedby="action-confirmation-message">
    <div class="panel confirmation-panel">
      <h1 id="action-confirmation-title"></h1>
      <p id="action-confirmation-message"></p>
      <div class="confirmation-actions">
        <button type="button" class="secondary" id="action-confirmation-cancel">Keep playing</button>
        <button type="button" id="action-confirmation-accept">Confirm</button>
      </div>
    </div>
  </div>`;

export const canvas = requiredElement<HTMLCanvasElement>("#game");
export const minimapCanvas = requiredElement<HTMLCanvasElement>("#minimap");
export const mapTotalAum = requiredElement<HTMLElement>("#map-total-aum");
export const mapFloorCash = requiredElement<HTMLElement>("#map-floor-cash");
export const hud = requiredElement<HTMLDivElement>("#hud");
export const overlay = requiredElement<HTMLDivElement>("#overlay");
export const actionConfirmation = requiredElement<HTMLDivElement>("#action-confirmation");
export const actionConfirmationTitle = requiredElement<HTMLElement>("#action-confirmation-title");
export const actionConfirmationMessage = requiredElement<HTMLElement>("#action-confirmation-message");
export const actionConfirmationCancel = requiredElement<HTMLButtonElement>("#action-confirmation-cancel");
export const actionConfirmationAccept = requiredElement<HTMLButtonElement>("#action-confirmation-accept");

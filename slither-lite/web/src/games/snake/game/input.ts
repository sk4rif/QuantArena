export interface InputState {
  aim: number;
  boost: boolean;
  panX: number;
  panY: number;
}

export class PointerInput {
  readonly state: InputState = { aim: 0, boost: false, panX: 0, panY: 0 };
  private panningEnabled = false;
  private readonly pressedPanKeys = new Set<string>();
  private edgePanX = 0;
  private edgePanY = 0;

  constructor(private readonly element: HTMLElement) {
    element.addEventListener("pointermove", this.onMove);
    element.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onEdgeMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    element.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  setPanningEnabled(enabled: boolean): void {
    this.panningEnabled = enabled;
    if (!enabled) this.resetPan();
  }

  destroy(): void {
    this.element.removeEventListener("pointermove", this.onMove);
    this.element.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onEdgeMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
  }

  private readonly onMove = (event: PointerEvent): void => {
    const bounds = this.element.getBoundingClientRect();
    this.state.aim = Math.atan2(event.clientY - bounds.top - bounds.height / 2, event.clientX - bounds.left - bounds.width / 2);
  };

  private readonly onEdgeMove = (event: PointerEvent): void => {
    if (!this.panningEnabled || event.target !== this.element) {
      this.edgePanX = 0;
      this.edgePanY = 0;
    } else {
      const bounds = this.element.getBoundingClientRect();
      this.edgePanX = edgePanAxis(event.clientX - bounds.left, bounds.width);
      this.edgePanY = edgePanAxis(event.clientY - bounds.top, bounds.height);
    }
    this.updatePan();
  };

  private readonly onDown = (event: PointerEvent): void => {
    if (event.button === 0 || event.button === 2) this.state.boost = true;
  };

  private readonly onUp = (): void => {
    this.state.boost = false;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Space") this.state.boost = true;
    if (!this.panningEnabled || !isPanKey(event.code)) return;
    this.pressedPanKeys.add(event.code);
    this.updatePan();
    event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") this.state.boost = false;
    if (!isPanKey(event.code)) return;
    this.pressedPanKeys.delete(event.code);
    this.updatePan();
    if (this.panningEnabled) event.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.state.boost = false;
    this.resetPan();
  };

  private updatePan(): void {
    const keyPanX = Number(this.pressedPanKeys.has("ArrowRight")) - Number(this.pressedPanKeys.has("ArrowLeft"));
    const keyPanY = Number(this.pressedPanKeys.has("ArrowDown")) - Number(this.pressedPanKeys.has("ArrowUp"));
    this.state.panX = Math.max(-1, Math.min(1, keyPanX + this.edgePanX));
    this.state.panY = Math.max(-1, Math.min(1, keyPanY + this.edgePanY));
  }

  private resetPan(): void {
    this.pressedPanKeys.clear();
    this.edgePanX = 0;
    this.edgePanY = 0;
    this.updatePan();
  }
}

export function edgePanAxis(position: number, size: number, edgeSize = 56): number {
  if (position <= edgeSize) return -1;
  if (position >= size - edgeSize) return 1;
  return 0;
}

function isPanKey(code: string): boolean {
  return code === "ArrowLeft" || code === "ArrowRight" || code === "ArrowUp" || code === "ArrowDown";
}

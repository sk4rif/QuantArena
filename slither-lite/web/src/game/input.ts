export interface InputState {
  aim: number;
  boost: boolean;
}

export class PointerInput {
  readonly state: InputState = { aim: 0, boost: false };

  constructor(private readonly element: HTMLElement) {
    element.addEventListener("pointermove", this.onMove);
    element.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    element.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  destroy(): void {
    this.element.removeEventListener("pointermove", this.onMove);
    this.element.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  private readonly onMove = (event: PointerEvent): void => {
    const bounds = this.element.getBoundingClientRect();
    this.state.aim = Math.atan2(event.clientY - bounds.top - bounds.height / 2, event.clientX - bounds.left - bounds.width / 2);
  };

  private readonly onDown = (event: PointerEvent): void => {
    if (event.button === 0 || event.button === 2) this.state.boost = true;
  };

  private readonly onUp = (): void => {
    this.state.boost = false;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Space") this.state.boost = true;
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") this.state.boost = false;
  };
}

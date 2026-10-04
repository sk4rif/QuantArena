export const NANOS_PER_DOLLAR = 1_000_000_000;

export type Availability = "open" | "comingSoon";

export interface Level {
  key: string;
  label: string;
  stakeNanos: number;
  money: "Paper" | "Real";
  blurb: string;
  availability: Availability;
  origin: string;
}

export interface ArenaHooks {
  accountName(): string | undefined;
  requestSignIn(): void;
  signedIn(): boolean;
  level(): Level | undefined;
  changeLevel(): void;
}

export interface GameRuntime {
  start(hooks: ArenaHooks): void;
  isLive(): boolean;
  confirmAction(title: string, message: string, acceptLabel: string): Promise<boolean>;
  leave(): void;
  refreshLobby(): void;
}

export interface GameModule {
  id: string;
  name: string;
  tagline: string;
  description: string;
  icon: string;
  availability: Availability;
  levels: readonly Level[];
  renderLevels(gameId: string | undefined): string;
  renderRules(): string;
  hydrateRules(root: HTMLElement): Promise<void>;
  renderDocs(): string;
  bindDocs(root: HTMLElement): void;
  runtime: GameRuntime;
  leaveConfirmation: {
    title: string;
    message: string;
    acceptLabel: string;
  };
}

export function formatMoney(nanos: number): string {
  return `$${(nanos / NANOS_PER_DOLLAR).toFixed(nanos < NANOS_PER_DOLLAR ? 3 : 2)}`;
}

export function isFree(level: Level): boolean {
  return level.money === "Paper";
}

export function stakeLabel(level: Level): string {
  return isFree(level) ? "Free" : formatMoney(level.stakeNanos);
}

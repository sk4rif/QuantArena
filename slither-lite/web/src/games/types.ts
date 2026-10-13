export const NANOS_PER_DOLLAR = 1_000_000_000;

export type Availability = "open" | "comingSoon";

/** A geographic region that runs its own, independent copy of a level. */
export interface Region {
  /** Short slug that the server reports as `region` in `/config`, e.g. `us-east`. */
  key: string;
  label: string;
  /** Where the servers physically are, shown next to the label, e.g. `New York`. */
  location: string;
}

/** One running arena: a level in a region. Each is a separate server process with its own floor and leaderboard. */
export interface LevelServer {
  region: Region;
  /** Origin serving that arena's `/config`, `/health`, `/ws` and `/bot`; empty string means the site's own origin. */
  origin: string;
}

export interface Level {
  key: string;
  label: string;
  stakeNanos: number;
  money: "Paper" | "Real";
  blurb: string;
  availability: Availability;
  /** Where the level is running. Never empty: an undeployed level falls back to the site's own origin. */
  servers: readonly LevelServer[];
}

export interface ArenaHooks {
  accountName(): string | undefined;
  requestSignIn(): void;
  signedIn(): boolean;
  level(): Level | undefined;
  /** The arena to connect to; may wait briefly for ping measurements when the region is automatic. */
  server(): Promise<LevelServer | undefined>;
  changeLevel(): void;
  startAsSpectator(): boolean;
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
  /** Attaches behaviour (the region picker) to the HTML from `renderLevels`. */
  bindLevels(root: HTMLElement): void;
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

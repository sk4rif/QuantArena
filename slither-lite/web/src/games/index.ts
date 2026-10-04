import { snakeGame } from "./snake";
import type { GameModule } from "./types";

export type { GameModule, Level } from "./types";
export { formatMoney, isFree, NANOS_PER_DOLLAR, stakeLabel } from "./types";

export const games: readonly GameModule[] = [snakeGame];

export function findGame(id: string | undefined): GameModule | undefined {
  return games.find((game) => game.id === id);
}

export function findLevel(game: GameModule, key: string | undefined) {
  return game.levels.find((level) => level.key === key);
}

export function defaultLevel(game: GameModule) {
  return game.levels.find((level) => level.availability === "open");
}

import { formatMoney, NANOS_PER_DOLLAR } from "../net/protocol";

/**
 * Static registry of the games on the platform and the levels each one runs.
 *
 * Every level is a separate server process, because a Rust server runs exactly one tier
 * (`SLITHER_TIER`). Until a directory endpoint exists, the mapping lives here: `origin` is
 * the origin serving that level's `/config` and `/ws`, and an empty string means the origin
 * the site itself is served from.
 */

export type Availability = "open" | "comingSoon";

export interface Level {
  /** Matches the server's tier key, so a level can be checked against `/config`. */
  key: string;
  label: string;
  stakeNanos: number;
  money: "Paper" | "Real";
  blurb: string;
  availability: Availability;
  origin: string;
}

export interface Game {
  id: string;
  name: string;
  tagline: string;
  /** Two-line summary shown on the game card. */
  description: string;
  /** Inline SVG thumbnail for the game card. */
  icon: string;
  availability: Availability;
  levels: readonly Level[];
}

const dollars = (amount: number): number => amount * NANOS_PER_DOLLAR;

/** A snake of money balls, drawn head-last so the trail fades out behind it. */
const snakeIcon = `
<svg viewBox="0 0 64 64" width="52" height="52" aria-hidden="true" focusable="false">
  <circle cx="9" cy="46" r="3" fill="#dc4325" opacity=".22" />
  <circle cx="18" cy="49" r="3.6" fill="#dc4325" opacity=".34" />
  <circle cx="27" cy="47" r="4.2" fill="#dc4325" opacity=".48" />
  <circle cx="35" cy="41" r="4.8" fill="#dc4325" opacity=".64" />
  <circle cx="42" cy="33" r="5.4" fill="#dc4325" opacity=".82" />
  <circle cx="48" cy="23" r="6.6" fill="#dc4325" />
  <circle cx="50.5" cy="20.5" r="1.7" fill="#fcfaf8" />
  <circle cx="17" cy="20" r="2.6" fill="#2e1c16" opacity=".3" />
</svg>`;

const snakeLevels: readonly Level[] = [
  {
    key: "paper",
    label: "PaperArena",
    stakeNanos: dollars(5),
    money: "Paper",
    blurb: "Practice and bot training. Same rules and API as every other level, with no real funds.",
    availability: "open",
    origin: "",
  },
  {
    key: "casual",
    label: "Casual",
    stakeNanos: dollars(5),
    money: "Real",
    blurb: "The entry level for real stakes.",
    availability: "comingSoon",
    origin: "",
  },
  {
    key: "mid",
    label: "Mid",
    stakeNanos: dollars(25),
    money: "Real",
    blurb: "Bigger tickets, longer runs before a cash-out pays off.",
    availability: "comingSoon",
    origin: "",
  },
  {
    key: "standard",
    label: "Standard",
    stakeNanos: dollars(50),
    money: "Real",
    blurb: "For players who are comfortable with the cost curves.",
    availability: "comingSoon",
    origin: "",
  },
  {
    key: "high",
    label: "High",
    stakeNanos: dollars(100),
    money: "Real",
    blurb: "High stakes. Boost is expensive and mistakes are costly.",
    availability: "comingSoon",
    origin: "",
  },
  {
    key: "elite",
    label: "Elite",
    stakeNanos: dollars(150),
    money: "Real",
    blurb: "The top level.",
    availability: "comingSoon",
    origin: "",
  },
];

export const games: readonly Game[] = [
  {
    id: "snake",
    name: "QuantArena",
    tagline: "Every snake is a portfolio",
    description:
      "Collect cash off the floor and avoid other snakes. Cash out before the starvation tax and boost costs eat your worth.",
    icon: snakeIcon,
    availability: "open",
    levels: snakeLevels,
  },
];

/**
 * A paper level charges no real money, so showing an amount only invites the question of who
 * pays it. The simulated ticket still exists and is what the snake starts at; it is stated in
 * the lobby and the rules rather than on the card.
 */
export function isFree(level: Level): boolean {
  return level.money === "Paper";
}

export function stakeLabel(level: Level): string {
  return isFree(level) ? "Free" : formatMoney(level.stakeNanos);
}

export function findGame(id: string | undefined): Game | undefined {
  return games.find((game) => game.id === id);
}

export function findLevel(game: Game, key: string | undefined): Level | undefined {
  return game.levels.find((level) => level.key === key);
}

/** The level a player lands on by default, i.e. the first one they can actually enter. */
export function defaultLevel(game: Game): Level | undefined {
  return game.levels.find((level) => level.availability === "open");
}

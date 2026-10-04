import "./styles.css";
import { bindDocs, renderDocs } from "./pages/docs";
import { renderLevels } from "./pages/levels";
import { hydrateRules, renderRules } from "./pages/rules";
import { snakeRuntime } from "./runtime";
import { NANOS_PER_DOLLAR, type GameModule, type Level } from "../types";

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

export const snakeGame: GameModule = {
  id: "snake",
  name: "QuantArena",
  tagline: "Every snake is a portfolio",
  description:
    "Collect cash off the floor and avoid other snakes. Cash out before the starvation tax and boost costs eat your worth.",
  icon: snakeIcon,
  availability: "open",
  levels: snakeLevels,
  renderLevels,
  renderRules,
  hydrateRules,
  renderDocs,
  bindDocs,
  runtime: snakeRuntime,
  leaveConfirmation: {
    title: "Leave the arena?",
    message:
      "Your snake will keep moving in its last direction with boost off. You cannot control or reclaim it after leaving; it remains vulnerable and keeps paying starvation tax until it dies or a pending cash-out completes.",
    acceptLabel: "Leave and abandon",
  },
};

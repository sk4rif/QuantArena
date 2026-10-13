import "./styles.css";
import { bindDocs, renderDocs } from "./pages/docs";
import { bindLevels, renderLevels } from "./pages/levels";
import { hydrateRules, renderRules } from "./pages/rules";
import { snakeRuntime } from "./runtime";
import { snakeServers } from "./servers";
import { NANOS_PER_DOLLAR, type GameModule, type Level } from "../types";

const dollars = (amount: number): number => amount * NANOS_PER_DOLLAR;

/** A snake of money balls, drawn head-last so the trail fades out behind it. */
const snakeIcon = `
<svg class="snake-card-preview" viewBox="0 0 260 96" width="260" height="96" aria-hidden="true" focusable="false">
  <style>
    .snake-icon-player { offset-path: path("M 130 10 A 115 38 0 0 1 245 48 A 115 38 0 0 1 130 86 A 115 38 0 0 1 15 48 A 115 38 0 0 1 130 10 Z"); animation: snake-icon-lap 6s linear infinite; }
    .snake-icon-player-head { animation-delay: -1s; }
    .snake-icon-player-1 { animation-delay: -.86s; }
    .snake-icon-player-2 { animation-delay: -.72s; }
    .snake-icon-player-3 { animation-delay: -.58s; }
    .snake-icon-player-4 { animation-delay: -.44s; }
    .snake-icon-rival { offset-path: path("M 130 30 A 52 18 0 0 1 182 48 A 52 18 0 0 1 130 66 A 52 18 0 0 1 78 48 A 52 18 0 0 1 130 30 Z"); animation: snake-icon-lap 7.5s linear infinite; }
    .snake-icon-rival-head { animation-delay: -3.2s; }
    .snake-icon-rival-1 { animation-delay: -3.03s; }
    .snake-icon-rival-2 { animation-delay: -2.86s; }
    .snake-icon-rival-3 { animation-delay: -2.69s; }
    .snake-icon-cash { transform-box: fill-box; transform-origin: center; animation-duration: 6s; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
    .snake-icon-cash-a { animation-name: snake-icon-cash-a; }
    .snake-icon-cash-b { animation-name: snake-icon-cash-b; }
    .snake-icon-cash-c { animation-name: snake-icon-cash-c; }
    .snake-icon-cash-d { animation: snake-icon-cash-d 7.5s ease-in-out infinite; }
    @keyframes snake-icon-lap { to { offset-distance: 100%; } }
    @keyframes snake-icon-cash-a { 0%, 8% { opacity: 1; transform: scale(1); } 11%, 88% { opacity: 0; transform: scale(.3); } 91%, 100% { opacity: 1; transform: scale(1); } }
    @keyframes snake-icon-cash-b { 0%, 33% { opacity: 1; transform: scale(1); } 36%, 88% { opacity: 0; transform: scale(.3); } 91%, 100% { opacity: 1; transform: scale(1); } }
    @keyframes snake-icon-cash-c { 0%, 58% { opacity: 1; transform: scale(1); } 61%, 88% { opacity: 0; transform: scale(.3); } 91%, 100% { opacity: 1; transform: scale(1); } }
    @keyframes snake-icon-cash-d { 0%, 32% { opacity: 1; transform: scale(1); } 35%, 94% { opacity: 0; transform: scale(.3); } 97%, 100% { opacity: 1; transform: scale(1); } }
    @media (prefers-reduced-motion: reduce) {
      .snake-icon-player, .snake-icon-rival, .snake-icon-cash { animation: none; }
      .snake-icon-player-head { offset-distance: 17%; }
      .snake-icon-player-1 { offset-distance: 15%; }
      .snake-icon-player-2 { offset-distance: 13%; }
      .snake-icon-player-3 { offset-distance: 11%; }
      .snake-icon-player-4 { offset-distance: 9%; }
      .snake-icon-rival-head { offset-distance: 43%; }
      .snake-icon-rival-1 { offset-distance: 41%; }
      .snake-icon-rival-2 { offset-distance: 39%; }
      .snake-icon-rival-3 { offset-distance: 37%; }
    }
  </style>
  <path d="M15 24H245M15 48H245M15 72H245M65 8V88M130 8V88M195 8V88" fill="none" stroke="#dc4325" stroke-width=".6" opacity=".08" />
  <g fill="#93d9a3">
    <circle class="snake-icon-cash snake-icon-cash-a" cx="245" cy="48" r="2.4" />
    <circle class="snake-icon-cash snake-icon-cash-b" cx="130" cy="86" r="3" fill="#398a50" />
    <circle class="snake-icon-cash snake-icon-cash-c" cx="15" cy="48" r="2.1" />
    <circle class="snake-icon-cash snake-icon-cash-d" cx="78" cy="48" r="2.6" fill="#66b879" />
  </g>
  <circle class="snake-icon-rival snake-icon-rival-3" r="2.5" fill="#1e88e5" opacity=".45" />
  <circle class="snake-icon-rival snake-icon-rival-2" r="3" fill="#1e88e5" opacity=".62" />
  <circle class="snake-icon-rival snake-icon-rival-1" r="3.5" fill="#1e88e5" opacity=".82" />
  <g class="snake-icon-rival snake-icon-rival-head">
    <circle r="4.3" fill="#1e88e5" />
    <circle cx="1.4" cy="-1.5" r="1" fill="#fcfaf8" />
  </g>
  <circle class="snake-icon-player snake-icon-player-4" r="2.5" fill="#f12605" opacity=".35" />
  <circle class="snake-icon-player snake-icon-player-3" r="3" fill="#f12605" opacity=".5" />
  <circle class="snake-icon-player snake-icon-player-2" r="3.5" fill="#f12605" opacity=".68" />
  <circle class="snake-icon-player snake-icon-player-1" r="4" fill="#f12605" opacity=".85" />
  <g class="snake-icon-player snake-icon-player-head">
    <circle r="5" fill="#f12605" />
    <circle cx="1.7" cy="-1.8" r="1.2" fill="#fcfaf8" />
  </g>
</svg>`;

const snakeLevels: readonly Level[] = [
  {
    key: "paper",
    label: "PaperArena",
    stakeNanos: dollars(5),
    money: "Paper",
    blurb: "Practice and bot training. Same rules and API as every other level, with no real funds.",
    availability: "open",
    servers: snakeServers("paper"),
  },
  {
    key: "casual",
    label: "Casual",
    stakeNanos: dollars(5),
    money: "Real",
    blurb: "The entry level for real stakes.",
    availability: "comingSoon",
    servers: snakeServers("casual"),
  },
  {
    key: "mid",
    label: "Mid",
    stakeNanos: dollars(25),
    money: "Real",
    blurb: "Bigger tickets, longer runs before a cash-out pays off.",
    availability: "comingSoon",
    servers: snakeServers("mid"),
  },
  {
    key: "standard",
    label: "Standard",
    stakeNanos: dollars(50),
    money: "Real",
    blurb: "For players who are comfortable with the cost curves.",
    availability: "comingSoon",
    servers: snakeServers("standard"),
  },
  {
    key: "high",
    label: "High",
    stakeNanos: dollars(100),
    money: "Real",
    blurb: "High stakes. Boost is expensive and mistakes are costly.",
    availability: "comingSoon",
    servers: snakeServers("high"),
  },
  {
    key: "elite",
    label: "Elite",
    stakeNanos: dollars(150),
    money: "Real",
    blurb: "The top level.",
    availability: "comingSoon",
    servers: snakeServers("elite"),
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
  bindLevels,
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

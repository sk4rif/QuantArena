import type { ArenaHooks, GameRuntime } from "../types";

type Arena = typeof import("./arena");

let arena: Arena | undefined;
let loading: Promise<Arena> | undefined;
let startRequested = false;

function loadArena(): Promise<Arena> {
  loading ??= import("./arena").then((module) => {
    arena = module;
    return module;
  });
  return loading;
}

export const snakeRuntime: GameRuntime = {
  start: (hooks: ArenaHooks) => {
    startRequested = true;
    void loadArena().then((module) => {
      if (startRequested) module.startArena(hooks);
    });
  },
  isLive: () => arena?.isLive() ?? false,
  confirmAction: (title, message, acceptLabel) =>
    loadArena().then((module) => module.confirmArenaAction(title, message, acceptLabel)),
  leave: () => {
    startRequested = false;
    arena?.leaveArena();
  },
  refreshLobby: () => arena?.refreshLobby(),
};

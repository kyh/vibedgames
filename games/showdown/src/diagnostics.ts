// Read-only state snapshot for the repo's playtest tooling, published as
// window.__GAME_DIAGNOSTICS__ (see the playtest skill). Typed through a small
// structural view of Game so this file compiles whatever the game class is
// growing at the moment — the online fields are read only when present.

export interface DiagnosticsPlayer {
  alive: boolean;
  cubes: number;
  hp: number;
  kills: number;
  x: number;
  z: number;
}

export interface DiagnosticsSession {
  isHost?: boolean;
  playerCount?: number;
  playerId?: string | null;
  seq?: number;
  status?: string;
}

export interface DiagnosticsSource {
  brawlers: readonly { alive: boolean }[];
  frameStats?: { calls: number; triangles: number };
  mode?: string;
  paused: boolean;
  pendingResult: object | null;
  player: DiagnosticsPlayer | null;
  session?: DiagnosticsSession | null;
  state: string;
}

export interface OnlineDiagnostics {
  connection: string | null;
  isHost: boolean;
  mode: string;
  playerId: string | null;
  players: number;
  seq: number;
}

export interface Diagnostics {
  brawlersLeft: number;
  /** A result screen is up: the match ended and its reveal delay has elapsed. */
  complete: boolean;
  entities: number;
  frame: number;
  online: OnlineDiagnostics | null;
  paused: boolean;
  phase: string;
  player: DiagnosticsPlayer | null;
  renderer: { calls: number; triangles: number } | null;
  score: number;
}

let frame = 0;

/** Count a rendered frame. Game calls this once per animation frame. */
export const tick = (): void => {
  frame += 1;
};

const onlineDiagnostics = (game: DiagnosticsSource): OnlineDiagnostics | null => {
  const { mode, session } = game;
  if (mode === undefined || mode === "solo") {
    return null;
  }
  return {
    connection: session?.status ?? null,
    isHost: session?.isHost ?? false,
    mode,
    playerId: session?.playerId ?? null,
    players: session?.playerCount ?? 0,
    seq: session?.seq ?? 0,
  };
};

export const buildDiagnostics = (game: DiagnosticsSource): Diagnostics => {
  const { player } = game;
  return {
    brawlersLeft: game.brawlers.filter((b) => b.alive).length,
    complete: game.state === "ended" && game.pendingResult === null,
    entities: game.brawlers.length,
    frame,
    online: onlineDiagnostics(game),
    paused: game.paused,
    phase: game.state,
    player: player
      ? {
          alive: player.alive,
          cubes: player.cubes,
          hp: player.hp,
          kills: player.kills,
          x: player.x,
          z: player.z,
        }
      : null,
    renderer: game.frameStats ? { ...game.frameStats } : null,
    score: player?.kills ?? 0,
  };
};

declare global {
  interface Window {
    __GAME_DIAGNOSTICS__?: Diagnostics;
  }
}

/** Publish a live getter; every read builds a fresh snapshot. */
export const installDiagnostics = (game: DiagnosticsSource): void => {
  Object.defineProperty(window, "__GAME_DIAGNOSTICS__", {
    configurable: true,
    get: () => buildDiagnostics(game),
  });
};

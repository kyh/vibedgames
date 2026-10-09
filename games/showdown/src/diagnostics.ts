// Read-only state snapshot for the repo's playtest tooling, published as
// window.__GAME_DIAGNOSTICS__ (see the playtest skill). Typed through a small
// structural view of Game so the builder needs no renderer to run.

import { publishDiagnostics } from "@vibedgames/playtest";

import type { PlaytestSense } from "./playtest-sense";

export interface DiagnosticsPlayer {
  alive: boolean;
  cubes: number;
  hp: number;
  kills: number;
  x: number;
  z: number;
}

export interface DiagnosticsSession {
  isHost: boolean;
  playerCount: number;
  playerId: string | null;
  seq: number;
  stats: { intentsHz: number; snapshotBytes: number; snapshotHz: number };
  status: string;
}

/** A guest's view of its own netcode: prediction against the host, and how far behind server time remotes render. */
export interface DiagnosticsGuest {
  interpDelayMs: number | null;
  prediction: { lagMs: number | null; lastError: number };
}

export interface DiagnosticsSource {
  brawlers: readonly { alive: boolean }[];
  frameStats: { calls: number; triangles: number };
  mode: string;
  netGuest: DiagnosticsGuest | null;
  paused: boolean;
  pendingResult: object | null;
  player: DiagnosticsPlayer | null;
  session: DiagnosticsSession | null;
  state: string;
}

export interface NetDiagnostics {
  /** Snapshots sent (host) or received (guest) per second. */
  snapshotHz: number;
  /** Mean size of one whole snapshot frame, bytes: the most a tick's frame costs, as only changed leaves travel. */
  snapshotBytes: number;
  /** Intents this client sent per second. */
  intentsHz: number;
  /** Guest: how far the host's copy of our body trails its prediction (≈ round trip), ms. */
  lagMs: number | null;
  /** Guest: the last position error the host reported, world units (under 0.12 is ignored). */
  correction: number | null;
  /** Guest: how far behind server time remote bodies render (the relay's fastest recent trip plus the render delay: INTERP_DELAY_MS, or more when the stream needs it), ms. */
  interpDelayMs: number | null;
}

export interface OnlineDiagnostics {
  connection: string | null;
  isHost: boolean;
  mode: string;
  net: NetDiagnostics | null;
  playerId: string | null;
  players: number;
  seq: number;
}

/** Kills dominate; cubes make looting count, so progress shows before the first kill. */
const KILL_SCORE = 100;
const CUBE_SCORE = 10;

/** The playtest sense fields are present whenever the local player exists. */
export interface Diagnostics extends Partial<PlaytestSense> {
  brawlersLeft: number;
  /** A result screen is up: the match ended and its reveal delay has elapsed. */
  complete: boolean;
  entities: number;
  frame: number;
  online: OnlineDiagnostics | null;
  paused: boolean;
  phase: string;
  player: DiagnosticsPlayer | null;
  renderer: { calls: number; triangles: number };
  score: number;
}

let frame = 0;

/** Count a rendered frame. Game calls this once per animation frame. */
export const tick = (): void => {
  frame += 1;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

const netDiagnostics = (game: DiagnosticsSource): NetDiagnostics | null => {
  const { netGuest, session } = game;
  if (!session) {
    return null;
  }
  const lag = netGuest?.prediction.lagMs ?? null;
  return {
    ...session.stats,
    correction: netGuest ? round2(netGuest.prediction.lastError) : null,
    interpDelayMs: netGuest?.interpDelayMs ?? null,
    lagMs: lag === null ? null : Math.round(lag),
  };
};

const onlineDiagnostics = (game: DiagnosticsSource): OnlineDiagnostics | null => {
  const { mode, session } = game;
  if (mode === "solo") {
    return null;
  }
  return {
    connection: session?.status ?? null,
    isHost: session?.isHost ?? false,
    mode,
    net: netDiagnostics(game),
    playerId: session?.playerId ?? null,
    players: session?.playerCount ?? 0,
    seq: session?.seq ?? 0,
  };
};

export const buildDiagnostics = (
  game: DiagnosticsSource,
  sense: PlaytestSense | null = null,
): Diagnostics => {
  const { player } = game;
  return {
    ...sense,
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
    renderer: { ...game.frameStats },
    score: player ? player.kills * KILL_SCORE + player.cubes * CUBE_SCORE : 0,
  };
};

/** Publish a live getter; every read builds a fresh snapshot. `sense` adds what the player can see. */
export const installDiagnostics = (
  game: DiagnosticsSource,
  sense: () => PlaytestSense | null = () => null,
): void => {
  publishDiagnostics(() => buildDiagnostics(game, sense()));
};

import type { MultiplayerConnectionStatus } from "./types.js";

export interface NetStats {
  /** Remote-entity frames rendered: one per `Interpolator.sample()` with data. */
  frames: number;
  /**
   * Of those, drawn past the newest update: extrapolated or held because the
   * next one was late. A sender that keeps stamping while idle never starves.
   */
  starved: number;
  /** Of those, held still past the extrapolation limit: a visible freeze. */
  stalled: number;
  /** Updates `Interpolator.push()` accepted. */
  updates: number;
}

export interface NetClientInfo {
  /** The room the client is in (an overflow sibling once the first fills). */
  room: string;
  status: MultiplayerConnectionStatus;
  playerId: string | null;
  isHost: boolean;
  /** Fastest recent round trip to the server (ms); null before the first probe returns. */
  rttMs: number | null;
}

/** What `globalThis.__VG_NET__` holds. */
export interface NetProbe {
  /** Totals since the page loaded, or since `reset()`. */
  stats: () => NetStats;
  /** Zero the totals, to measure a window. */
  reset: () => void;
  /** Every live `MultiplayerClient` on the page. */
  clients: () => NetClientInfo[];
}

declare global {
  var __VG_NET__: NetProbe | undefined;
}

/** A client that can report itself (MultiplayerClient). */
export interface NetClientSource {
  netInfo: () => NetClientInfo;
}

const totals: NetStats = { frames: 0, stalled: 0, starved: 0, updates: 0 };
const sources = new Set<NetClientSource>();
let published = false;

/** A copy of the totals since the page loaded, or since the last reset. */
export const netStats = () => ({ ...totals });

const probe: NetProbe = {
  clients: () => [...sources].map((source) => source.netInfo()),
  reset: () => {
    totals.frames = 0;
    totals.stalled = 0;
    totals.starved = 0;
    totals.updates = 0;
  },
  stats: netStats,
};

const publish = () => {
  if (published) {
    return;
  }

  published = true;
  Object.defineProperty(globalThis, "__VG_NET__", { configurable: true, value: probe });
};

/** Count one rendered frame; `overMs` is how far render time ran past the newest update. */
export const countFrame = (overMs: number, maxExtrapolateMs: number) => {
  publish();
  totals.frames += 1;

  if (overMs > 0) {
    totals.starved += 1;
  }

  if (overMs > maxExtrapolateMs) {
    totals.stalled += 1;
  }
};

/** Count one accepted update. */
export const countUpdate = () => {
  publish();
  totals.updates += 1;
};

/** List a live client in `clients()`; the returned function takes it off again. */
export const trackClient = (source: NetClientSource) => {
  publish();
  sources.add(source);

  return () => {
    sources.delete(source);
  };
};

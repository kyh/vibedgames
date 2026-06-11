// Multiplayer intent protocol. Guests send INTENT events; only the host mutates
// the world. The host broadcasts the world snapshot under sharedState.snap.

import type { AbilityKey } from "../data/heroes";
import type { Order } from "../sim/types";

export const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";
export const PARTY = "vg-server";
export const ROOM = "moba-default";

export type Intent =
  | { kind: "join"; defId: string }
  | { kind: "order"; order: Order }
  | { kind: "cast"; key: AbilityKey; point?: { x: number; y: number }; targetId?: string }
  | { kind: "level"; key: AbilityKey }
  | { kind: "buy"; itemId: string }
  | { kind: "useItem"; slot: number; point?: { x: number; y: number } }
  | { kind: "dash"; dx: number; dy: number };

export const INTENT_EVENT = "intent";

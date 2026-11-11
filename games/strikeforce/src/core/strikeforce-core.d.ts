import type { NetHooks } from "./types";

/**
 * Boot the game into #app (index.html's markup) and start its loop. `net`
 * becomes `G.net` once every module exists and runs the match.
 */
export declare function bootStrikeforce(net?: NetHooks): Promise<void>;

import type { NetHooks } from "./types";

/**
 * Boot the game into #app (index.html's markup) and start its loop. `net`
 * becomes `G.net` once every module exists; omit it for the original
 * single-player game.
 */
export declare function bootSaltline(net?: NetHooks): Promise<void>;

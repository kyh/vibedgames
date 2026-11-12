import type { CoreModules, NetHooks } from "./types";

/**
 * Boot the game into #app (index.html's markup) and start its loop. `net`
 * becomes `G.net` once every module exists and runs the match; `modules`
 * replace the core's own (the garrison in place of its machines).
 */
export declare function bootStrikeforce(
  net?: NetHooks,
  modules?: Partial<CoreModules>,
): Promise<void>;

/**
 * A failure of the pilot harness itself — bad flags, a browser that won't
 * start, a game that never published its contract, a model that can't be
 * reached — as opposed to a game that fails its playtest. `vg pilot` exits 2
 * on these and 1 on a failed playtest, so an agent can tell them apart.
 */
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

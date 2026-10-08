// A match on this client's own clock: solo against the AI — offline, or
// online with nobody to play. The same sim and the same rollback engine as a
// tick-room match, with every tick confirmed the moment it is due, so the
// scene renders both the same way; and since nobody else shares the clock,
// a pause can stop it.

import { TICK_MS } from "../shared/constants";
import type { SlotInput } from "../shared/input";
import type { SimState, Slot } from "../shared/sim";
import { Rollback } from "./rollback";

export class LocalDriver {
  readonly kind = "local";
  readonly mySlot: Slot;
  readonly engine: Rollback;
  /** The fractional tick shown. */
  private horizon: number;

  constructor(base: SimState, mySlot: Slot) {
    this.mySlot = mySlot;
    this.engine = new Rollback(base, mySlot);
    this.horizon = base.tick;
  }

  /** Each frame: run the clock (unless paused) and step every tick now due. */
  frame(input: SlotInput, dtMs: number, running: boolean): number {
    if (running) {
      this.horizon += dtMs / TICK_MS;
    }
    const due = Math.floor(this.horizon);
    const inputs = this.mySlot === 0 ? ([input, null] as const) : ([null, input] as const);
    for (let n = this.engine.confirmedTick + 1; n <= due; n += 1) {
      this.engine.confirm(n, inputs);
    }
    return this.horizon;
  }
}

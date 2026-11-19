import { TICK_MS } from "../shared/constants";
import type { SlotInput } from "../shared/input";
import type { SimState, Slot } from "../shared/sim";
import { Rollback } from "./rollback";

export class LocalDriver {
  readonly kind = "local";
  readonly mySlot: Slot;
  readonly engine: Rollback;
  private horizon: number;

  constructor(base: SimState, mySlot: Slot) {
    this.mySlot = mySlot;
    this.engine = new Rollback(base, mySlot);
    this.horizon = base.tick;
  }

  /** Each frame: run the clock (unless paused) and step every tick now due. */
  frame(input: SlotInput, dtMs: number, running: boolean) {
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

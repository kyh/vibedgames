import { sameInput } from "../shared/input";
import type { SlotInput } from "../shared/input";
import { cloneSim, stepSim } from "../shared/sim";
import type { SimState, Slot } from "../shared/sim";

/** Slot A's and slot B's inputs on one tick (null: nobody steers that paddle). */
export type SlotInputs = readonly [SlotInput | null, SlotInput | null];

/** Furthest the prediction runs past the confirmed tick (0.5 s at 60 Hz):
 *  beyond it the picture holds until the tick stream catches up. */
export const MAX_PREDICT_TICKS = 30;
const HISTORY = 64;
const LOST_TICKS = 60;

interface Change {
  input: SlotInput;
  tick: number;
}

/** How the prediction has fared, for diagnostics and the tests. */
export interface RollbackStats {
  confirmed: number;
  /** Confirmed ticks whose inputs differed from the prediction. */
  mispredicted: number;
  /** Of those, the ones where this player's own input landed later than sent. */
  ownLate: number;
  /** Ticks stepped again after a misprediction, and the deepest single rewind. */
  resimulated: number;
  deepest: number;
}

export class Rollback {
  /** This player's slot, whose inputs come from the local schedule; null to predict every slot. */
  readonly mine: Slot | null;
  readonly stats: RollbackStats = {
    confirmed: 0,
    deepest: 0,
    mispredicted: 0,
    ownLate: 0,
    resimulated: 0,
  };
  private confirmedState: SimState;
  private held: SlotInputs;
  private readonly predicted: SimState[] = [];
  private readonly guesses: SlotInputs[] = [];
  private readonly history: SimState[] = [];
  private local: Change[] = [];
  private furthest: number;
  private ownLateSince = 0;
  private ownOnTimeSince = 0;
  private resend = false;

  constructor(base: SimState, mine: Slot | null, held: SlotInputs = [null, null]) {
    this.mine = mine;
    this.confirmedState = base;
    this.held = held;
    this.history.push(base);
    this.furthest = base.tick;
  }

  get confirmed() {
    return this.confirmedState;
  }

  get confirmedTick() {
    return this.confirmedState.tick;
  }

  /** The newest tick predicted (the confirmed one when nothing is). */
  get predictedTick() {
    return this.confirmedState.tick + this.predicted.length;
  }

  /** The state after tick `t`: predicted, confirmed, or a recent confirmed one. */
  stateAt(t: number) {
    const ahead = t - this.confirmedState.tick;

    return ahead > 0 ? this.predicted[ahead - 1] : this.history.at(ahead - 1);
  }

  /** The input this player holds at tick `t`, as far as this client knows. */
  localAt(t: number) {
    let input = this.mine === null ? null : this.held[this.mine];

    for (const change of this.local) {
      if (change.tick > t) {
        break;
      }

      ({ input } = change);
    }

    return input;
  }

  /** This player's input from tick `at` on — never before the next unconfirmed tick. */
  setLocal(at: number, input: SlotInput) {
    const tick = Math.max(at, this.confirmedState.tick + 1);
    this.local = this.local.filter((change) => change.tick < tick);
    this.local.push({ input, tick });
    this.discardFrom(tick);
  }

  /**
   * The room's tick `n` with every slot's input. False on a gap — `n` is not
   * the next tick, so this timeline can no longer follow the stream.
   */
  confirm(n: number, inputs: SlotInputs) {
    if (n !== this.confirmedState.tick + 1) {
      return false;
    }

    const [next] = this.predicted;
    const [guess] = this.guesses;
    const { mine } = this;

    if (guess !== undefined && mine !== null) {
      if (!sameInput(guess[mine], inputs[mine])) {
        this.stats.ownLate += 1;
        this.ownLateSince += 1;
      } else if (!sameInput(this.held[mine], inputs[mine])) {
        this.ownOnTimeSince += 1;
      }
    }

    if (
      next !== undefined &&
      guess !== undefined &&
      sameInput(guess[0], inputs[0]) &&
      sameInput(guess[1], inputs[1])
    ) {
      this.predicted.shift();
      this.guesses.shift();
      this.confirmedState = next;
    } else {
      if (next !== undefined) {
        this.stats.mispredicted += 1;
        this.stats.deepest = Math.max(this.stats.deepest, this.predicted.length);
      }

      const state = cloneSim(this.confirmedState);
      stepSim(state, inputs[0], inputs[1]);
      this.confirmedState = state;
      this.predicted.length = 0;
      this.guesses.length = 0;
    }

    this.held = inputs;
    this.history.push(this.confirmedState);

    if (this.history.length > HISTORY) {
      this.history.shift();
    }

    this.stats.confirmed += 1;
    this.settleLocal(n);

    return true;
  }

  /** Predict through tick `to`, at most MAX_PREDICT_TICKS past the confirmed
   *  tick. Returns the newest tick predicted. */
  predictTo(to: number) {
    const limit = Math.min(to, this.confirmedState.tick + MAX_PREDICT_TICKS);
    let last = this.predicted.at(-1) ?? this.confirmedState;

    for (let tick = last.tick + 1; tick <= limit; tick += 1) {
      const inputs = this.guessAt(tick);
      const state = cloneSim(last);
      stepSim(state, inputs[0], inputs[1]);
      this.predicted.push(state);
      this.guesses.push(inputs);

      if (tick <= this.furthest) {
        this.stats.resimulated += 1;
      } else {
        this.furthest = tick;
      }

      last = state;
    }

    return this.predictedTick;
  }

  /** Ticks an own input landed late on, since the last call: the lead is too short. */
  takeOwnLate() {
    const late = this.ownLateSince;
    this.ownLateSince = 0;

    return late;
  }

  /** Own changes that landed on the tick they were sent for, since the last call. */
  takeOwnOnTime() {
    const onTime = this.ownOnTimeSince;
    this.ownOnTimeSince = 0;

    return onTime;
  }

  /** True once after an own input was given up as lost: send the input again. */
  takeResend() {
    const { resend } = this;
    this.resend = false;

    return resend;
  }

  private guessAt(tick: number) {
    const { held, mine } = this;

    if (mine === null) {
      return held satisfies SlotInputs;
    }

    const own = this.localAt(tick);

    return (mine === 0 ? [own, held[1]] : [held[0], own]) satisfies SlotInputs;
  }

  private discardFrom(tick: number) {
    const keep = Math.max(0, tick - this.confirmedState.tick - 1);

    if (this.predicted.length > keep) {
      this.predicted.length = keep;
      this.guesses.length = keep;
    }
  }

  private settleLocal(n: number) {
    while ((this.local[1]?.tick ?? Number.POSITIVE_INFINITY) <= n) {
      this.local.shift();
    }

    const [due] = this.local;
    const { mine } = this;

    if (due === undefined || due.tick > n || mine === null) {
      return;
    }

    if (sameInput(due.input, this.held[mine])) {
      this.local.shift();
    } else if (due.tick <= n - LOST_TICKS) {
      this.local.shift();
      this.resend = true;
    }
  }
}

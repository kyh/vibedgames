// Contested one-shot actions — a harvest, a pickup, the swing that fells a
// tree, a planting — are settled by claims: first come, first served, decided
// by the party server in one hop, with no host round trip and no host edge.
// The farmer claims the target and acts at once; if the server names someone
// else, it undoes what only the winner gets (the produce, the wood, the seed's
// spot). The host applies the world's side of every grant it hears.
//
// Keys carry the farm's epoch, so a reset farm never inherits an old one's
// claims, and a crop's generation, so an old harvest never blocks the next
// crop on that tile:
//   <w>:h:<idx>:<gen>  harvest crop <gen> of tile <idx>
//   <w>:p:<idx>:<gen>  plant crop <gen> of tile <idx>
//   <w>:c:<id>         chopping or breaking object <id>: a hold with a TTL,
//                      renewed every swing, so two farmers never work one tree
//   <w>:x:<id>         object <id> felled, broken or picked

export type ClaimTarget =
  | { kind: "harvest"; idx: number; gen: number }
  | { kind: "plant"; idx: number; gen: number }
  | { kind: "hold"; id: number }
  | { kind: "clear"; id: number };

/** How long a swing holds a tree or rock for its farmer; every swing renews it. */
export const WORK_HOLD_MS = 3000;

const targetKey = (target: ClaimTarget): string => {
  switch (target.kind) {
    case "harvest": {
      return `h:${target.idx}:${target.gen}`;
    }
    case "plant": {
      return `p:${target.idx}:${target.gen}`;
    }
    case "hold": {
      return `c:${target.id}`;
    }
    case "clear": {
      return `x:${target.id}`;
    }
    // no default
  }
};

/** Every key of the farm under `epoch` starts with this. */
export const claimPrefix = (epoch: number): string => `${epoch}:`;

export const claimKey = (epoch: number, target: ClaimTarget): string =>
  `${claimPrefix(epoch)}${targetKey(target)}`;

const KEY = /^(?<epoch>\d+):(?:(?<tile>[hp]):(?<idx>\d+):(?<gen>\d+)|(?<object>[cx]):(?<id>\d+))$/u;

const targetOf = (groups: Partial<Record<string, string>>): ClaimTarget | null => {
  const { gen, id, idx, object, tile } = groups;
  if (tile !== undefined && idx !== undefined && gen !== undefined) {
    const at = { gen: Number(gen), idx: Number(idx) };
    return tile === "h" ? { kind: "harvest", ...at } : { kind: "plant", ...at };
  }
  if (object !== undefined && id !== undefined) {
    return object === "c" ? { id: Number(id), kind: "hold" } : { id: Number(id), kind: "clear" };
  }
  return null;
};

/** A claim key off the wire: its epoch and target, or null for any other key. */
export const parseClaimKey = (key: string): { epoch: number; target: ClaimTarget } | null => {
  const groups = KEY.exec(key)?.groups;
  const epoch = groups?.epoch;
  const target = groups ? targetOf(groups) : null;
  return epoch === undefined || target === null ? null : { epoch: Number(epoch), target };
};

/** What landing an effect arms: `won` once the claim is granted (at once if it
 *  already is), `lost` if the server names someone else. */
export interface ClaimOutcome {
  won?: () => void;
  lost?: (owner: string) => void;
}

type Answer = { state: "asked" } | { state: "won" } | { state: "lost"; owner: string };

/** One claim this farmer made, from the ask to the server's word. */
export class ClaimTicket {
  private answer: Answer = { state: "asked" };
  private outcome: ClaimOutcome = {};

  /** Granted from the start: offline, or before the room's farm arrived, nothing arbitrates. */
  static won(): ClaimTicket {
    const ticket = new ClaimTicket();
    ticket.answer = { state: "won" };
    return ticket;
  }

  /** Who the server gave the target to instead — then the effect must not
   *  land — or null while asked or once won. */
  get lostTo(): string | null {
    const { answer } = this;
    return answer.state === "lost" ? answer.owner : null;
  }

  /** The effect landed: run `won` now if granted, or arm both for the answer. */
  land(outcome: ClaimOutcome): void {
    const { answer } = this;
    if (answer.state === "won") {
      outcome.won?.();
    } else if (answer.state === "lost") {
      outcome.lost?.(answer.owner);
    } else {
      this.outcome = outcome;
    }
  }

  /** The server's word: granted to this farmer, or held by `owner`. */
  settle(won: boolean, owner: string): void {
    if (this.answer.state !== "asked") {
      return;
    }
    this.answer = won ? { state: "won" } : { owner, state: "lost" };
    const { outcome } = this;
    this.outcome = {};
    if (won) {
      outcome.won?.();
    } else {
      outcome.lost?.(owner);
    }
  }
}

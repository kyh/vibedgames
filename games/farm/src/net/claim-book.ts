import { ClaimTicket } from "./claims";

// The claims this farmer is still waiting on the server's word for, and how
// each settles. See ./claims for what is claimed and why.

/** Where claims go: NetSession, or a test double. */
export interface ClaimNet {
  readonly playerId: string | null;
  claim: (key: string, options?: { ttlMs?: number }) => void;
  ownerOf: (key: string) => string | null;
}

/** The claims this farmer is waiting on the server's word for. */
export class ClaimBook {
  private readonly waiting = new Map<string, ClaimTicket[]>();

  /** Claim `key` now. A re-claim of a key this farmer holds renews it. */
  ask(net: ClaimNet, key: string, ttlMs?: number): ClaimTicket {
    const ticket = new ClaimTicket();
    const queue = this.waiting.get(key);
    if (queue) {
      queue.push(ticket);
    } else {
      this.waiting.set(key, [ticket]);
    }
    net.claim(key, ttlMs === undefined ? undefined : { ttlMs });
    return ticket;
  }

  /**
   * The server named `owner` for `key` (onClaim). A grant to this farmer wins
   * every ticket waiting on it; any other owner — the grant someone got first,
   * or this farmer's refusal — loses them. A release (null) answers nothing.
   * Hear only while connected: a reconnect hands this farmer's claims over to
   * its new id before the sync that tells it that id.
   */
  hear(net: ClaimNet, key: string, owner: string | null): void {
    if (owner === null) {
      return;
    }
    const queue = this.waiting.get(key);
    if (!queue) {
      return;
    }
    this.waiting.delete(key);
    for (const ticket of queue) {
      ticket.settle(owner === net.playerId, owner);
    }
  }

  /** Settle whatever the room's claims now answer: a reconnect announces the
   *  hand-over of this farmer's claims before the sync that names its new id,
   *  so they settle here once connected. Call each frame while connected. */
  poll(net: ClaimNet): void {
    for (const key of this.waiting.keys()) {
      this.hear(net, key, net.ownerOf(key));
    }
  }

  /** Forget every wait — a new farm, whose claims will never be answered. */
  clear(): void {
    this.waiting.clear();
  }
}

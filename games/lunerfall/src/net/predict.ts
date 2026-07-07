// Guest-side client prediction support (pure — no Phaser, sim-testable).
//
// Online, the guest runs its OWN PlayerBody through the real fixed-step sim on
// local input, so movement responds the frame a key goes down instead of after
// a host round-trip. The host stays authoritative: every snapshot carries its
// copy of that body, and the Reconciler decides what (if anything) to correct.
//
// The authoritative copy LAGS local time by ~RTT, so comparing it against the
// body's CURRENT position would report a phantom error of velocity × latency
// and constantly drag a running player backwards. Instead the authority is
// matched against a short history of recent predicted positions: if it sits on
// the recent local trajectory, host and guest agree and nothing is corrected.
// A real divergence (missed held input, hit-stop timing, drift) deviates from
// EVERY history point; the smallest deviation is the true error:
//   ≤ DEADZONE     noise / quantisation — ignore
//   < SNAP_DIST    blend: shift the body (and the history, so the remainder
//                  isn't re-reported in full) a fraction per snapshot
//   ≥ SNAP_DIST    snap: the host did something prediction can't know (round
//                  respawn, teleport) — jump straight to authority
// Hits / downs / deaths are corrected by the scene on their state EDGES (a
// snap on a hit reads AS the hit); this class only owns positional convergence.

export const SNAP_DIST = 48; // px of trajectory deviation that snaps to authority
export const DEADZONE = 3; // px of deviation ignored as noise
export const BLEND_RATE = 0.3; // fraction of a small deviation corrected per snapshot
const HISTORY = 32; // predicted steps kept (~0.53s at 60Hz) — covers the RTT window

export type Correction =
  | { kind: "aligned" }
  | { kind: "blend"; dx: number; dy: number }
  | { kind: "snap" };

export class Reconciler {
  private hist: { x: number; y: number }[] = [];

  /** Record the predicted position after each fixed sim step. */
  record(x: number, y: number): void {
    this.hist.push({ x, y });
    if (this.hist.length > HISTORY) this.hist.shift();
  }

  /** Forget the trajectory (room change, snap, respawn). */
  reset(): void {
    this.hist.length = 0;
  }

  /** Fold one authoritative position into the recent local trajectory. */
  reconcile(ax: number, ay: number): Correction {
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const h of this.hist) {
      const d = (ax - h.x) * (ax - h.x) + (ay - h.y) * (ay - h.y);
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    if (!best) return { kind: "aligned" }; // no history yet (just spawned/reset)
    const dev = Math.sqrt(bd);
    if (dev <= DEADZONE) return { kind: "aligned" };
    if (dev >= SNAP_DIST) return { kind: "snap" };
    const dx = (ax - best.x) * BLEND_RATE;
    const dy = (ay - best.y) * BLEND_RATE;
    for (const h of this.hist) {
      h.x += dx;
      h.y += dy;
    }
    return { kind: "blend", dx, dy };
  }
}

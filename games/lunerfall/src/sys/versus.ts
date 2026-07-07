import type { NetVersus } from "../net/snapshot";

// Pure online-versus match state machine — no Phaser, so the sim harness can
// drive it headlessly. The scene owns bodies/FX/wire and reacts to what step()
// reports; this owns phases, per-duelist hearts, round scores, and the
// first-to-VS_WIN_SCORE result. Sides are fixed: host = left, guest = right.

export type VsSide = "host" | "guest";
export type VsPhase = NetVersus["phase"];
// What a step() crossed into, for the scene to react (respawn, banners, stings).
export type VsTransition = "fight" | "respawn" | "matchEnd" | null;

export const VS_WIN_SCORE = 3; // round wins to take the match
export const VS_HEARTS = 5; // per-duelist hearts, refilled every round
export const VS_HIT_CAP = 2; // max hearts one hit can take (finishers/specials)
export const VS_COUNTDOWN = 1.4; // s frozen at round start ("ROUND n")
export const VS_ROUND_END = 1.8; // s of round-winner banner before the reset
export const VS_END_HOLD = 1.2; // s before the match-end rematch prompt arms
export const VS_BIOME = 5; // VOIDSANCTUM — the duel stage palette

export const vsOther = (s: VsSide): VsSide => (s === "host" ? "guest" : "host");

/** Inputs are dropped in these phases (round intro / match end). Shared with
 * the guest, which mirrors the host's freeze from the broadcast phase so its
 * predicted body doesn't fight the authority during a countdown. */
export const vsPhaseFrozen = (p: VsPhase): boolean => p === "countdown" || p === "matchEnd";

export class VersusMatch {
  phase: VsPhase = "waiting";
  round = 0;
  t = 0;
  hp: Record<VsSide, number> = { host: VS_HEARTS, guest: VS_HEARTS };
  score: Record<VsSide, number> = { host: 0, guest: 0 };
  winner: VsSide | null = null; // round winner in roundEnd, match in matchEnd

  /** Both duelists present (or a rematch): scores wiped, round 1 countdown. */
  beginMatch() {
    this.score = { host: 0, guest: 0 };
    this.round = 0;
    this.startRound();
  }

  /** The opponent left: back to the lobby state. */
  reset() {
    this.phase = "waiting";
    this.round = 0;
    this.t = 0;
    this.hp = { host: VS_HEARTS, guest: VS_HEARTS };
    this.score = { host: 0, guest: 0 };
    this.winner = null;
  }

  private startRound() {
    this.round++;
    this.hp = { host: VS_HEARTS, guest: VS_HEARTS };
    this.winner = null;
    this.phase = "countdown";
    this.t = VS_COUNTDOWN;
  }

  /** Inputs are dropped while frozen (round intro / match end). */
  get frozen(): boolean {
    return vsPhaseFrozen(this.phase);
  }

  /** True once the match-end hold lapsed and a rematch press is accepted. */
  get canRematch(): boolean {
    return this.phase === "matchEnd" && this.t <= 0;
  }

  /** Advance timers; returns the transition the scene must react to, if any. */
  step(dt: number): VsTransition {
    if (this.phase === "countdown") {
      this.t -= dt;
      if (this.t <= 0) {
        this.phase = "fighting";
        this.t = 0;
        return "fight";
      }
    } else if (this.phase === "roundEnd") {
      this.t -= dt;
      if (this.t <= 0) {
        const w = this.winner;
        if (w && this.score[w] >= VS_WIN_SCORE) {
          this.phase = "matchEnd";
          this.t = VS_END_HOLD;
          return "matchEnd";
        }
        this.startRound();
        return "respawn";
      }
    } else if (this.phase === "matchEnd") {
      this.t = Math.max(0, this.t - dt);
    }
    return null;
  }

  /** Land a hit (capped) in the fighting phase; true when it ends the round. */
  damage(side: VsSide, dmg: number): boolean {
    if (this.phase !== "fighting") return false;
    this.hp[side] = Math.max(0, this.hp[side] - Math.min(VS_HIT_CAP, dmg));
    if (this.hp[side] > 0) return false;
    const w = vsOther(side);
    this.winner = w;
    this.score[w]++;
    this.phase = "roundEnd";
    this.t = VS_ROUND_END;
    return true;
  }

  /** Self-heal (mooni's special) restores that duelist's own hearts, capped. */
  heal(side: VsSide, n: number) {
    if (this.phase !== "fighting") return;
    this.hp[side] = Math.min(VS_HEARTS, this.hp[side] + n);
  }

  encode(): NetVersus {
    return {
      phase: this.phase,
      round: this.round,
      t: Math.round(this.t * 100) / 100,
      hostHp: this.hp.host,
      guestHp: this.hp.guest,
      hostScore: this.score.host,
      guestScore: this.score.guest,
      winner: this.winner,
    };
  }
}

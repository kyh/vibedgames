import type { NetVersus } from "../net/snapshot";

// Pure online-versus match state machine — no Phaser, so the sim harness can
// drive it headlessly. The scene owns bodies/FX/wire and reacts to what step()
// reports; this owns phases, per-duelist hearts, round scores, and the
// first-to-VS_WIN_SCORE result. Sides are fixed: host = left, guest = right.

export type VsSide = "host" | "guest";
export type VsPhase = NetVersus["phase"];
// What a step() crossed into, for the scene to react (respawn, banners, stings).
export type VsTransition = "fight" | "respawn" | "matchEnd" | null;

// round wins to take the match
export const VS_WIN_SCORE = 3;
// per-duelist hearts, refilled every round
export const VS_HEARTS = 5;
// max hearts one hit can take (finishers/specials)
export const VS_HIT_CAP = 2;
// s frozen at round start ("ROUND n")
export const VS_COUNTDOWN = 1.4;
// s of round-winner banner before the reset
export const VS_ROUND_END = 1.8;
// s before the match-end rematch prompt arms
export const VS_END_HOLD = 1.2;
// VOIDSANCTUM — the duel stage palette
export const VS_BIOME = 5;

export const vsOther = (s: VsSide): VsSide => (s === "host" ? "guest" : "host");

/** Inputs are dropped in these phases (round intro / match end). Shared with
 * the guest, which mirrors the host's freeze from the broadcast phase so its
 * predicted body doesn't fight the authority during a countdown. */
export const vsPhaseFrozen = (p: VsPhase): boolean => p === "countdown" || p === "matchEnd";

export class VersusMatch {
  phase: VsPhase = "waiting";
  round = 0;
  t = 0;
  hp = { guest: VS_HEARTS, host: VS_HEARTS } satisfies Record<VsSide, number>;
  score = { guest: 0, host: 0 } satisfies Record<VsSide, number>;
  // round winner in roundEnd, match in matchEnd
  winner: VsSide | null = null;

  /** Full precision for authority handoff (encode is the rounded wire view). */
  checkpoint() {
    return {
      hp: { ...this.hp },
      phase: this.phase,
      round: this.round,
      score: { ...this.score },
      t: this.t,
      winner: this.winner,
    };
  }

  restore(state: VersusCheckpoint): void {
    this.phase = state.phase;
    this.round = state.round;
    this.t = state.t;
    this.hp = { ...state.hp };
    this.score = { ...state.score };
    this.winner = state.winner;
  }

  /** Both duelists present (or a rematch): scores wiped, round 1 countdown. */
  beginMatch() {
    this.score = { guest: 0, host: 0 };
    this.round = 0;
    this.startRound();
  }

  /** The opponent left: back to the lobby state. */
  reset() {
    this.phase = "waiting";
    this.round = 0;
    this.t = 0;
    this.hp = { guest: VS_HEARTS, host: VS_HEARTS };
    this.score = { guest: 0, host: 0 };
    this.winner = null;
  }

  private startRound() {
    this.round += 1;
    this.hp = { guest: VS_HEARTS, host: VS_HEARTS };
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
    if (this.phase !== "fighting") {
      return false;
    }
    this.hp[side] = Math.max(0, this.hp[side] - Math.min(VS_HIT_CAP, dmg));
    if (this.hp[side] > 0) {
      return false;
    }
    const w = vsOther(side);
    this.winner = w;
    this.score[w] += 1;
    this.phase = "roundEnd";
    this.t = VS_ROUND_END;
    return true;
  }

  /** Self-heal (mooni's special) restores that duelist's own hearts, capped. */
  heal(side: VsSide, n: number) {
    if (this.phase !== "fighting") {
      return;
    }
    this.hp[side] = Math.min(VS_HEARTS, this.hp[side] + n);
  }

  encode(): NetVersus {
    return {
      guestHp: this.hp.guest,
      guestScore: this.score.guest,
      hostHp: this.hp.host,
      hostScore: this.score.host,
      phase: this.phase,
      round: this.round,
      t: Math.round(this.t * 100) / 100,
      winner: this.winner,
    };
  }
}

export type VersusCheckpoint = ReturnType<VersusMatch["checkpoint"]>;

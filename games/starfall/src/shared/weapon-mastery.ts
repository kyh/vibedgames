type MasteryWeapon = "RAILGUN" | "GLAIVE";

export type WeaponMasteryState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{
      phase: "active";
      weapon: MasteryWeapon;
      generation: number;
      startedAt: number;
      endsAt: number;
      contacts: number;
      completions: number;
    }>;

/** Per-beam contact record, handed out by `shot()` and kept on the beam by the
 * owner. The generation fences beams fired under an earlier pickup. */
export interface MasteryShot {
  readonly generation: number;
  readonly outward: Set<string>;
  readonly returning: Set<string>;
  completed: boolean;
}

/** HUD-only technique feedback for RAILGUN (pierce two enemies with one shot)
 * and GLAIVE (hit the same enemy out and back). No gameplay effect. */
const inWindow = (state: { startedAt: number; endsAt: number }, now: number): boolean =>
  now >= state.startedAt && now < state.endsAt;

export class WeaponMastery {
  private current: WeaponMasteryState = { phase: "idle" };
  private generation = 0;

  get state(): WeaponMasteryState {
    return this.current;
  }

  pickup(weapon: string, now: number, weaponUntil: number): void {
    if ((weapon !== "RAILGUN" && weapon !== "GLAIVE") || weaponUntil <= now) {
      this.clear();
      return;
    }
    const state = this.current;
    if (state.phase === "active" && state.weapon === weapon && inWindow(state, now)) {
      this.current = { ...state, endsAt: weaponUntil };
      return;
    }
    this.generation += 1;
    this.current = {
      completions: 0,
      contacts: 0,
      endsAt: weaponUntil,
      generation: this.generation,
      phase: "active",
      startedAt: now,
      weapon,
    };
  }

  shot(weapon: string, now: number): MasteryShot | null {
    const state = this.current;
    if (state.phase !== "active" || state.weapon !== weapon || !inWindow(state, now)) {
      return null;
    }
    return {
      completed: false,
      generation: state.generation,
      outward: new Set(),
      returning: new Set(),
    };
  }

  contact(shot: MasteryShot, enemyId: string, returning: boolean, now: number): void {
    const state = this.current;
    if (state.phase !== "active" || shot.generation !== state.generation || !inWindow(state, now)) {
      return;
    }
    const leg = returning ? shot.returning : shot.outward;
    if (leg.has(enemyId)) {
      return;
    }
    leg.add(enemyId);
    const complete =
      state.weapon === "RAILGUN" ? shot.outward.size >= 2 : returning && shot.outward.has(enemyId);
    const first = complete && !shot.completed;
    shot.completed ||= complete;
    this.current = {
      ...state,
      completions: state.completions + (first ? 1 : 0),
      contacts: state.contacts + 1,
    };
  }

  /** Once per frame: expiry, death and loadout changes end the window. */
  advance(now: number, alive: boolean, weapon: string): void {
    const state = this.current;
    if (state.phase !== "active") {
      return;
    }
    if (!alive || weapon !== state.weapon || !inWindow(state, now)) {
      this.clear();
    }
  }

  clear(): void {
    this.current = { phase: "idle" };
  }
}

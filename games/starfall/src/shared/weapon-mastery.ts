type MasteryWeapon = "RAILGUN" | "GLAIVE";
export type MasteryShot = Readonly<{ generation: number; id: number }>;
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

type ShotContacts = { outward: Set<string>; returning: Set<string>; completed: boolean };

/** Personal technique feedback from acquired weapons and live local beams.
 * It owns no gameplay deadlines, rewards, randomness or network state. */
export class WeaponMastery {
  private current: WeaponMasteryState = { phase: "idle" };
  private generation = 0;
  private nextShot = 0;
  private readonly shots = new Map<number, ShotContacts>();

  get state(): WeaponMasteryState {
    return this.current;
  }

  pickup(weapon: string, now: number, weaponUntil: number): void {
    if (
      (weapon !== "RAILGUN" && weapon !== "GLAIVE") ||
      !Number.isFinite(now) ||
      !Number.isFinite(weaponUntil) ||
      weaponUntil <= now
    ) {
      this.clear();
      return;
    }
    const state = this.current;
    if (
      state.phase === "active" &&
      state.weapon === weapon &&
      now >= state.startedAt &&
      now < state.endsAt
    ) {
      this.current = { ...state, endsAt: weaponUntil };
      return;
    }
    this.clear();
    this.current = {
      phase: "active",
      weapon,
      generation: ++this.generation,
      startedAt: now,
      endsAt: weaponUntil,
      contacts: 0,
      completions: 0,
    };
  }

  /** Capture ownership at creation: an old glaive cannot join a later pickup. */
  shot(weapon: string, now: number): MasteryShot | null {
    const state = this.current;
    if (
      state.phase !== "active" ||
      state.weapon !== weapon ||
      now < state.startedAt ||
      now >= state.endsAt
    )
      return null;
    return { generation: state.generation, id: this.nextShot++ };
  }

  contact(shotId: MasteryShot, enemyId: string, returning: boolean, now: number): void {
    const state = this.current;
    if (
      state.phase !== "active" ||
      shotId.generation !== state.generation ||
      now < state.startedAt ||
      now >= state.endsAt
    )
      return;
    let shot = this.shots.get(shotId.id);
    if (!shot) {
      shot = { outward: new Set(), returning: new Set(), completed: false };
      this.shots.set(shotId.id, shot);
    }
    const leg = returning ? shot.returning : shot.outward;
    if (leg.has(enemyId)) return;
    leg.add(enemyId);
    const complete =
      state.weapon === "RAILGUN" ? shot.outward.size >= 2 : returning && shot.outward.has(enemyId);
    const first = complete && !shot.completed;
    shot.completed ||= complete;
    this.current = {
      ...state,
      contacts: state.contacts + 1,
      completions: state.completions + Number(first),
    };
  }

  advance(now: number, alive: boolean, weapon: string, liveShots: readonly MasteryShot[]): void {
    const state = this.current;
    if (state.phase !== "active") return;
    if (!alive || weapon !== state.weapon || now < state.startedAt || now >= state.endsAt) {
      this.clear();
      return;
    }
    const live = new Set(liveShots.map((shot) => shot.id));
    for (const id of this.shots.keys()) if (!live.has(id)) this.shots.delete(id);
  }

  clear(): void {
    this.current = { phase: "idle" };
    this.shots.clear();
  }

  get trackedShots(): number {
    return this.shots.size;
  }
}

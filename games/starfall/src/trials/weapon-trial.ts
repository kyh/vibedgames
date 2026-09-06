export type TrialKind = "railgun" | "glaive";
export type TrialChoice = {
  kind: TrialKind;
  weapon: "RAILGUN" | "GLAIVE";
  seed: number;
};

/** Only an explicit solo URL may configure practice. Public rooms ignore it. */
export function readTrialChoice(params: URLSearchParams): TrialChoice | null {
  if (params.get("offline") !== "1" || params.has("trailer")) return null;
  const kind = params.get("trial");
  if (kind !== "railgun" && kind !== "glaive") return null;
  const rawSeed = params.get("seed");
  const seed =
    rawSeed !== null && rawSeed !== "" && Number.isFinite(Number(rawSeed)) ? Number(rawSeed) : 7319;
  return { kind, weapon: kind === "railgun" ? "RAILGUN" : "GLAIVE", seed };
}

export function trialUrl(kind: TrialKind, seed = 7319): string {
  return `?offline=1&trial=${kind}&seed=${seed}`;
}

type TrialResultReason = "window" | "death" | "loadout";
export type TrialState =
  | { phase: "waiting" }
  | { phase: "active"; startedAt: number; endsAt: number; contacts: number; completions: number }
  | { phase: "result"; reason: TrialResultReason; contacts: number; completions: number };

type Shot = { outward: Set<string>; returning: Set<string>; completed: boolean };

/** Local accepted contacts only. No kills, remote snapshots or XP inference.
 * Shot identities belong to live local beams; prune removes expired attempts. */
export class WeaponTrial {
  private current: TrialState = { phase: "waiting" };
  private readonly shots = new Map<number, Shot>();

  constructor(readonly choice: TrialChoice) {}

  get state(): TrialState {
    return this.current;
  }

  begin(now: number, weaponUntil: number): void {
    if (this.current.phase !== "waiting" || weaponUntil <= now) return;
    this.current = {
      phase: "active",
      startedAt: now,
      endsAt: weaponUntil,
      contacts: 0,
      completions: 0,
    };
  }

  contact(shotId: number, enemyId: string, returning: boolean, now: number): void {
    const state = this.current;
    if (state.phase !== "active" || now < state.startedAt || now >= state.endsAt) return;
    let shot = this.shots.get(shotId);
    if (!shot) {
      shot = { outward: new Set(), returning: new Set(), completed: false };
      this.shots.set(shotId, shot);
    }
    const leg = returning ? shot.returning : shot.outward;
    if (leg.has(enemyId)) return;
    leg.add(enemyId);
    const complete =
      this.choice.kind === "railgun"
        ? shot.outward.size >= 2
        : returning && shot.outward.has(enemyId);
    const first = complete && !shot.completed;
    shot.completed ||= complete;
    this.current = {
      ...state,
      contacts: state.contacts + 1,
      completions: state.completions + Number(first),
    };
  }

  advance(now: number, alive: boolean, weapon: string, liveShotIds: readonly number[]): void {
    const state = this.current;
    if (state.phase !== "active") return;
    const reason =
      now >= state.endsAt
        ? "window"
        : !alive
          ? "death"
          : weapon !== this.choice.weapon
            ? "loadout"
            : null;
    if (reason) {
      this.current = {
        phase: "result",
        reason,
        contacts: state.contacts,
        completions: state.completions,
      };
      this.shots.clear();
      return;
    }
    const live = new Set(liveShotIds);
    for (const id of this.shots.keys()) if (!live.has(id)) this.shots.delete(id);
  }

  get trackedShots(): number {
    return this.shots.size;
  }
}

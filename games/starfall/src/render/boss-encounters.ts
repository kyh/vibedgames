import { bossPhase, type EnemyState } from "../shared/constants";

type Phase = 1 | 2 | 3;
export type BossObservation = Readonly<Pick<EnemyState, "id" | "kind" | "hp" | "maxHp">>;
export type BossEncounterCue =
  | { kind: "arrival"; id: string; phase: Phase }
  | { kind: "phase"; id: string; phase: 2 | 3 }
  | { kind: "defeat"; id: string };

const RETIRED_LIMIT = 32;

/** Presentation evidence only: observe valid worlds even when cues are silent.
 * Never infers a local killer, awards anything or queues missed announcements. */
export class BossEncounters {
  private epoch: number | null = null;
  private live = new Map<string, Phase>();
  private retired = new Set<string>();

  reset(): void {
    this.epoch = null;
    this.live.clear();
    this.retired.clear();
  }

  observe(epoch: number, enemies: readonly BossObservation[]): BossEncounterCue[] {
    if (!Number.isFinite(epoch)) return [];
    const present = new Set<string>();
    const phases = new Map<string, Phase>();
    for (const enemy of enemies) {
      if (enemy.kind !== "dreadnought") continue;
      present.add(enemy.id);
      if (
        !Number.isFinite(enemy.hp) ||
        !Number.isFinite(enemy.maxHp) ||
        enemy.hp <= 0 ||
        enemy.maxHp <= 0
      )
        continue;
      const phase = bossPhase(enemy.hp, enemy.maxHp);
      // Duplicate observations of one ID still produce at most one phase edge.
      if (phase > (phases.get(enemy.id) ?? 0)) phases.set(enemy.id, phase);
    }

    if (this.epoch !== epoch) {
      this.reset();
      this.epoch = epoch;
      for (const id of present) {
        const phase = phases.get(id);
        if (phase) this.live.set(id, phase);
        else this.retire(id);
      }
      return [];
    }

    const cues: BossEncounterCue[] = [];
    for (const id of present) {
      if (this.retired.has(id)) continue;
      const phase = phases.get(id);
      const previous = this.live.get(id);
      if (!phase) {
        // Keep positive-live evidence until actual removal. A first-dead entry
        // has no such evidence and cannot later replay as a stale arrival.
        if (!previous) this.retire(id);
      } else if (!previous) {
        this.live.set(id, phase);
        cues.push({ kind: "arrival", id, phase });
      } else if (phase !== 1 && phase > previous) {
        this.live.set(id, phase);
        cues.push({ kind: "phase", id, phase });
      }
    }
    for (const id of this.live.keys()) {
      if (present.has(id)) continue;
      this.live.delete(id);
      this.retire(id);
      cues.push({ kind: "defeat", id });
    }
    return cues;
  }

  diagnostics() {
    return Object.freeze({
      epoch: this.epoch,
      live: this.live.size,
      retired: this.retired.size,
      retiredLimit: RETIRED_LIMIT,
    });
  }

  private retire(id: string): void {
    this.retired.add(id);
    if (this.retired.size > RETIRED_LIMIT) {
      const oldest = this.retired.values().next().value;
      if (oldest !== undefined) this.retired.delete(oldest);
    }
  }
}

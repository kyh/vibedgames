import { bossPhase } from "../shared/constants";
import type { EnemyState } from "../shared/constants";

type Phase = 1 | 2 | 3;
export type BossObservation = Readonly<Pick<EnemyState, "id" | "kind" | "hp" | "maxHp">>;
export type BossEncounterCue =
  | { kind: "arrival"; id: string; phase: Phase }
  | { kind: "phase"; id: string; phase: Phase }
  | { kind: "defeat"; id: string };

const NO_CUES: readonly BossEncounterCue[] = [];

/** Edge-detects dreadnought arrival / phase / defeat from accepted world
 * snapshots. The first snapshot of an epoch is a baseline: nothing already
 * in it is announced, so late joins and host migration never replay cues. */
export class BossEncounters {
  private epoch: number | null = null;
  private readonly live = new Map<string, Phase>();

  reset(): void {
    this.epoch = null;
    this.live.clear();
  }

  observe(epoch: number, enemies: readonly BossObservation[]): readonly BossEncounterCue[] {
    if (!Number.isFinite(epoch)) {
      return NO_CUES;
    }
    const baseline = this.epoch !== epoch;
    if (baseline) {
      this.epoch = epoch;
      this.live.clear();
    }
    let cues: BossEncounterCue[] | null = null;
    for (const e of enemies) {
      if (e.kind !== "dreadnought" || !(e.hp > 0) || !(e.maxHp > 0)) {
        continue;
      }
      const phase = bossPhase(e.hp, e.maxHp);
      const previous = this.live.get(e.id);
      if (previous !== undefined && phase <= previous) {
        continue;
      }
      this.live.set(e.id, phase);
      if (baseline) {
        continue;
      }
      cues ??= [];
      cues.push(
        previous === undefined
          ? { id: e.id, kind: "arrival", phase }
          : { id: e.id, kind: "phase", phase },
      );
    }
    for (const id of this.live.keys()) {
      if (enemies.some((e) => e.id === id)) {
        continue;
      }
      this.live.delete(id);
      cues ??= [];
      cues.push({ id, kind: "defeat" });
    }
    return cues ?? NO_CUES;
  }
}

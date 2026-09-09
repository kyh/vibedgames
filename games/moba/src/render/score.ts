import { CELL, isLandCell } from "../data/map";
import { isEnemy } from "../sim/combat";
import type { World } from "../sim/types";

export type ScoreMode = "quiet" | "skirmish" | "battle" | "fallen";
export type SoundscapeFrame =
  | { kind: "silent"; time: number }
  | { kind: "ended"; time: number }
  | { kind: ScoreMode; time: number; water: boolean };

type Envelope = { dur: number; gain: number; attack: number; release: number; at: number };
export type ScoreNote = Envelope &
  (
    | {
        kind: "score-tone";
        voice: "bass" | "reed" | "pluck" | "drum";
        freq: number;
        wave: "sine" | "triangle";
        cutoff: number;
        endFreq?: number;
      }
    | { kind: "score-noise"; frequency: number; filter: BiquadFilterType }
  );
export type ScoreStep = {
  step: number;
  mode: ScoreMode;
  music: ScoreNote[];
  ambience: ScoreNote[];
};

export const SCORE_BPM = 84;
export const SCORE_STEP_SECONDS = 60 / SCORE_BPM / 2;
const LISTEN_RADIUS_SQ = 720 * 720;

/** Presentation reads accepted world state. Proximity without an actual attack
 * stays quiet; distant lane battles do not drive the local arrangement. */
export function readSoundscape(world: World, playerId: string): SoundscapeFrame {
  const time = world.now / 1000;
  if (world.phase === "ended") return { kind: "ended", time };
  const me = world.units.get(playerId);
  if (!me?.hero) return { kind: "silent", time };
  const cx = Math.floor(me.x / CELL);
  const cy = Math.floor(me.y / CELL);
  const water =
    !isLandCell(cx - 2, cy) ||
    !isLandCell(cx + 2, cy) ||
    !isLandCell(cx, cy - 2) ||
    !isLandCell(cx, cy + 2);
  if (!me.alive) return { kind: "fallen", time, water };
  let kind: ScoreMode = "quiet";
  for (const id in me.hero.recentDamageFrom) {
    const at = me.hero.recentDamageFrom[id] ?? 0;
    if (at > world.now || world.now - at > 1200) continue;
    const attacker = world.units.get(id);
    if (attacker?.kind === "hero" || attacker?.creep?.boss) kind = "battle";
    else if (kind === "quiet") kind = "skirmish";
  }
  for (const unit of world.units.values()) {
    if (!unit.alive || !isEnemy(me, unit)) continue;
    if ((unit.x - me.x) ** 2 + (unit.y - me.y) ** 2 > LISTEN_RADIUS_SQ) continue;
    const attacking =
      unit.pendingAttack !== null ||
      (unit.lastAttackAt > 0 &&
        unit.lastAttackAt <= world.now &&
        world.now - unit.lastAttackAt < 1200);
    const engaged = attacking || me.pendingAttack?.targetId === unit.id;
    if (!engaged) continue;
    if (unit.kind === "hero" || unit.creep?.boss) return { kind: "battle", time, water };
    if (kind === "quiet") kind = "skirmish";
  }
  return { kind, time, water };
}

const midi = (note: number): number => 440 * 2 ** ((note - 69) / 12);
const ROOTS = [50, 48, 55, 57, 50, 48, 55, 50];
const CHORDS = [
  [62, 65, 69, 64],
  [60, 64, 67, 62],
  [59, 62, 67, 69],
  [57, 60, 64, 67],
];
const WALK = [0, 2, 1, 3, 2, 1, 3, 2];

function instrument(
  voice: "bass" | "reed" | "pluck",
  pitch: number,
  gain: number,
  dur: number,
): ScoreNote {
  return {
    kind: "score-tone",
    voice,
    freq: midi(pitch),
    wave: voice === "bass" ? "sine" : "triangle",
    cutoff: voice === "bass" ? 360 : voice === "reed" ? 950 : 1500,
    dur,
    gain,
    attack: voice === "pluck" ? 0.008 : voice === "bass" ? 0.12 : 0.08,
    release: voice === "pluck" ? dur - 0.03 : Math.min(0.7, dur * 0.55),
    at: 0,
  };
}

/** Eight bars in D Dorian. More danger adds rhythm, not tempo or loudness.
 * Each step is a short recipe; no whole song is queued in the audio graph. */
export function scoreStep(step: number, mode: ScoreMode, water: boolean): ScoreStep {
  const bar = Math.floor(step / 8) % ROOTS.length;
  const beat = step % 8;
  const root = ROOTS[bar] ?? 50;
  const chord = CHORDS[bar % CHORDS.length] ?? [62, 65, 69, 64];
  const music: ScoreNote[] = [];
  const ambience: ScoreNote[] = [];
  if (beat === 0) {
    if (mode !== "fallen" || bar % 2 === 0)
      music.push(instrument("bass", root - 12, mode === "battle" ? 0.018 : 0.021, 2.35));
    if (mode === "quiet" || mode === "fallen")
      music.push(instrument("reed", root + 7, mode === "fallen" ? 0.008 : 0.012, 1.75));
  }
  const pluck =
    mode === "battle" ||
    (mode === "skirmish" && beat % 2 === 0) ||
    (mode === "quiet" && (beat === 2 || (beat === 6 && bar % 2 === 0)));
  if (pluck) {
    const pick = WALK[beat] ?? 0;
    music.push(
      instrument(
        "pluck",
        chord[pick] ?? root + 12,
        mode === "battle" ? 0.014 : 0.021,
        mode === "battle" ? 0.3 : 0.54,
      ),
    );
  }
  if ((mode === "battle" || mode === "skirmish") && (beat === 0 || beat === 4)) {
    music.push({
      kind: "score-tone",
      voice: "drum",
      freq: 88,
      endFreq: 48,
      wave: "sine",
      cutoff: 260,
      gain: mode === "battle" ? 0.032 : 0.02,
      dur: 0.17,
      attack: 0.006,
      release: 0.14,
      at: 0,
    });
  }
  if (mode === "battle" && beat === 6 && bar % 2 === 1)
    music.push(instrument("reed", (chord[2] ?? 69) + 12, 0.008, 0.7));
  if (mode === "quiet" && beat === 0 && bar % 4 === 1) {
    ambience.push({
      kind: "score-noise",
      frequency: 420,
      filter: "bandpass",
      gain: 0.01,
      dur: 1.8,
      attack: 0.3,
      release: 0.9,
      at: 0,
    });
    if (water)
      ambience.push({
        kind: "score-noise",
        frequency: 880,
        filter: "lowpass",
        gain: 0.007,
        dur: 1.25,
        attack: 0.18,
        release: 0.7,
        at: 0.035,
      });
  }
  return { step, mode, music, ambience };
}

/** Authoritative clock cursor. Repeated snapshots are quiet; jumps admit only
 * the current grid step. Audio pause/unlock never replays the skipped phrase. */
export class ScoreClock {
  private lastStep = -1;
  private lastTime = -1;
  private battleUntil = -1;
  private skirmishUntil = -1;
  mode: ScoreMode | "silent" = "silent";

  reset(): void {
    this.lastStep = -1;
    this.lastTime = -1;
    this.battleUntil = this.skirmishUntil = -1;
    this.mode = "silent";
  }

  /** A correction can rewind time without crossing a musical step boundary. */
  isRewind(time: number): boolean {
    return time < this.lastTime;
  }

  observe(frame: SoundscapeFrame, audible: boolean): ScoreStep | null {
    if (!Number.isFinite(frame.time) || frame.time < 0) {
      this.reset();
      return null;
    }
    if (this.isRewind(frame.time)) this.reset();
    this.lastTime = frame.time;
    const step = Math.floor(frame.time / SCORE_STEP_SECONDS);
    if (frame.kind === "silent" || frame.kind === "ended") {
      this.lastStep = step;
      this.mode = "silent";
      this.battleUntil = this.skirmishUntil = -1;
      return null;
    }
    if (frame.kind === "battle") this.battleUntil = frame.time + 4;
    if (frame.kind === "battle" || frame.kind === "skirmish") this.skirmishUntil = frame.time + 5;
    if (frame.kind === "fallen") this.battleUntil = this.skirmishUntil = -1;
    this.mode =
      frame.kind === "fallen"
        ? "fallen"
        : frame.time < this.battleUntil
          ? "battle"
          : frame.time < this.skirmishUntil
            ? "skirmish"
            : "quiet";
    if (step === this.lastStep) return null;
    this.lastStep = step;
    return audible ? scoreStep(step, this.mode, frame.water) : null;
  }

  get step(): number {
    return this.lastStep;
  }
}

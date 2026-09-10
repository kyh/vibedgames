import { CELL, isLandCell } from "../data/map";
import { isEnemy } from "../sim/combat";
import type { HeroState, Unit, World } from "../sim/types";

export type ScoreMode = "quiet" | "skirmish" | "battle" | "fallen";
export type SoundscapeFrame =
  | { kind: "silent"; time: number }
  | { kind: "ended"; time: number }
  | { kind: ScoreMode; time: number; water: boolean };

interface Envelope {
  dur: number;
  gain: number;
  attack: number;
  release: number;
  at: number;
}
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
export interface ScoreStep {
  step: number;
  mode: ScoreMode;
  music: ScoreNote[];
  ambience: ScoreNote[];
}

export const SCORE_BPM = 84;
export const SCORE_STEP_SECONDS = 60 / SCORE_BPM / 2;
const LISTEN_RADIUS_SQ = 720 * 720;

const nearWater = (me: Unit): boolean => {
  const cx = Math.floor(me.x / CELL);
  const cy = Math.floor(me.y / CELL);
  return (
    !isLandCell(cx - 2, cy) ||
    !isLandCell(cx + 2, cy) ||
    !isLandCell(cx, cy - 2) ||
    !isLandCell(cx, cy + 2)
  );
};

const isMajorThreat = (unit: Unit | undefined): boolean =>
  unit?.kind === "hero" || Boolean(unit?.creep?.boss);

const modeFromRecentDamage = (world: World, hero: HeroState): ScoreMode => {
  let kind: ScoreMode = "quiet";
  for (const id of Object.keys(hero.recentDamageFrom)) {
    const at = hero.recentDamageFrom[id] ?? 0;
    if (at > world.now || world.now - at > 1200) {
      continue;
    }
    if (isMajorThreat(world.units.get(id))) {
      kind = "battle";
    } else if (kind === "quiet") {
      kind = "skirmish";
    }
  }
  return kind;
};

const isEngagedWith = (world: World, me: Unit, unit: Unit): boolean => {
  const attacking =
    unit.pendingAttack !== null ||
    (unit.lastAttackAt > 0 &&
      unit.lastAttackAt <= world.now &&
      world.now - unit.lastAttackAt < 1200);
  return attacking || me.pendingAttack?.targetId === unit.id;
};

const modeFromNearbyEnemies = (world: World, me: Unit, initial: ScoreMode): ScoreMode => {
  let kind = initial;
  for (const unit of world.units.values()) {
    if (!unit.alive || !isEnemy(me, unit)) {
      continue;
    }
    if ((unit.x - me.x) ** 2 + (unit.y - me.y) ** 2 > LISTEN_RADIUS_SQ) {
      continue;
    }
    if (!isEngagedWith(world, me, unit)) {
      continue;
    }
    if (isMajorThreat(unit)) {
      return "battle";
    }
    if (kind === "quiet") {
      kind = "skirmish";
    }
  }
  return kind;
};

/** Presentation reads accepted world state. Proximity without an actual attack
 * stays quiet; distant lane battles do not drive the local arrangement. */
export const readSoundscape = (world: World, playerId: string): SoundscapeFrame => {
  const time = world.now / 1000;
  if (world.phase === "ended") {
    return { kind: "ended", time };
  }
  const me = world.units.get(playerId);
  if (!me?.hero) {
    return { kind: "silent", time };
  }
  const water = nearWater(me);
  if (!me.alive) {
    return { kind: "fallen", time, water };
  }
  const kind = modeFromNearbyEnemies(world, me, modeFromRecentDamage(world, me.hero));
  return { kind, time, water };
};

const midi = (note: number): number => 440 * 2 ** ((note - 69) / 12);
const ROOTS = [50, 48, 55, 57, 50, 48, 55, 50];
const CHORDS = [
  [62, 65, 69, 64],
  [60, 64, 67, 62],
  [59, 62, 67, 69],
  [57, 60, 64, 67],
];
const WALK = [0, 2, 1, 3, 2, 1, 3, 2];

type Voice = "bass" | "reed" | "pluck";

const VOICES = {
  bass: { attack: 0.12, cutoff: 360, wave: "sine" },
  pluck: { attack: 0.008, cutoff: 1500, wave: "triangle" },
  reed: { attack: 0.08, cutoff: 950, wave: "triangle" },
} satisfies Record<Voice, { attack: number; cutoff: number; wave: "sine" | "triangle" }>;

const instrument = (voice: Voice, pitch: number, gain: number, dur: number): ScoreNote => ({
  at: 0,
  attack: VOICES[voice].attack,
  cutoff: VOICES[voice].cutoff,
  dur,
  freq: midi(pitch),
  gain,
  kind: "score-tone",
  release: voice === "pluck" ? dur - 0.03 : Math.min(0.7, dur * 0.55),
  voice,
  wave: VOICES[voice].wave,
});

const DRUM_HIT_BEATS = new Set([0, 4]);

const drum = (mode: ScoreMode): ScoreNote => ({
  at: 0,
  attack: 0.006,
  cutoff: 260,
  dur: 0.17,
  endFreq: 48,
  freq: 88,
  gain: mode === "battle" ? 0.032 : 0.02,
  kind: "score-tone",
  release: 0.14,
  voice: "drum",
  wave: "sine",
});

const WIND: ScoreNote = {
  at: 0,
  attack: 0.3,
  dur: 1.8,
  filter: "bandpass",
  frequency: 420,
  gain: 0.01,
  kind: "score-noise",
  release: 0.9,
};

const SHORE: ScoreNote = {
  at: 0.035,
  attack: 0.18,
  dur: 1.25,
  filter: "lowpass",
  frequency: 880,
  gain: 0.007,
  kind: "score-noise",
  release: 0.7,
};

const pluckNow = (mode: ScoreMode, beat: number, bar: number): boolean => {
  if (mode === "battle") {
    return true;
  }
  if (mode === "skirmish") {
    return beat % 2 === 0;
  }
  return mode === "quiet" && (beat === 2 || (beat === 6 && bar % 2 === 0));
};

const downbeatNotes = (mode: ScoreMode, bar: number, root: number): ScoreNote[] => {
  const notes: ScoreNote[] = [];
  if (mode !== "fallen" || bar % 2 === 0) {
    notes.push(instrument("bass", root - 12, mode === "battle" ? 0.018 : 0.021, 2.35));
  }
  if (mode === "quiet" || mode === "fallen") {
    notes.push(instrument("reed", root + 7, mode === "fallen" ? 0.008 : 0.012, 1.75));
  }
  return notes;
};

const rhythmNotes = (
  mode: ScoreMode,
  beat: number,
  bar: number,
  chord: number[],
  root: number,
): ScoreNote[] => {
  const notes: ScoreNote[] = [];
  if (pluckNow(mode, beat, bar)) {
    const pick = WALK[beat] ?? 0;
    notes.push(
      instrument(
        "pluck",
        chord[pick] ?? root + 12,
        mode === "battle" ? 0.014 : 0.021,
        mode === "battle" ? 0.3 : 0.54,
      ),
    );
  }
  if ((mode === "battle" || mode === "skirmish") && DRUM_HIT_BEATS.has(beat)) {
    notes.push(drum(mode));
  }
  if (mode === "battle" && beat === 6 && bar % 2 === 1) {
    notes.push(instrument("reed", (chord[2] ?? 69) + 12, 0.008, 0.7));
  }
  return notes;
};

/** Eight bars in D Dorian. More danger adds rhythm, not tempo or loudness.
 * Each step is a short recipe; no whole song is queued in the audio graph. */
export const scoreStep = (step: number, mode: ScoreMode, water: boolean): ScoreStep => {
  const bar = Math.floor(step / 8) % ROOTS.length;
  const beat = step % 8;
  const root = ROOTS[bar] ?? 50;
  const chord = CHORDS[bar % CHORDS.length] ?? [62, 65, 69, 64];
  const music: ScoreNote[] = beat === 0 ? downbeatNotes(mode, bar, root) : [];
  music.push(...rhythmNotes(mode, beat, bar, chord, root));
  const ambience: ScoreNote[] = [];
  if (mode === "quiet" && beat === 0 && bar % 4 === 1) {
    ambience.push(WIND);
    if (water) {
      ambience.push(SHORE);
    }
  }
  return { ambience, mode, music, step };
};

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
    this.battleUntil = -1;
    this.skirmishUntil = -1;
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
    if (this.isRewind(frame.time)) {
      this.reset();
    }
    this.lastTime = frame.time;
    const step = Math.floor(frame.time / SCORE_STEP_SECONDS);
    if (frame.kind === "silent" || frame.kind === "ended") {
      this.lastStep = step;
      this.mode = "silent";
      this.battleUntil = -1;
      this.skirmishUntil = -1;
      return null;
    }
    if (frame.kind === "battle") {
      this.battleUntil = frame.time + 4;
    }
    if (frame.kind === "battle" || frame.kind === "skirmish") {
      this.skirmishUntil = frame.time + 5;
    }
    if (frame.kind === "fallen") {
      this.battleUntil = -1;
      this.skirmishUntil = -1;
    }
    this.mode = this.resolveMode(frame.kind, frame.time);
    if (step === this.lastStep) {
      return null;
    }
    this.lastStep = step;
    return audible ? scoreStep(step, this.mode, frame.water) : null;
  }

  private resolveMode(kind: ScoreMode, time: number): ScoreMode {
    if (kind === "fallen") {
      return "fallen";
    }
    if (time < this.battleUntil) {
      return "battle";
    }
    return time < this.skirmishUntil ? "skirmish" : "quiet";
  }

  get step(): number {
    return this.lastStep;
  }
}

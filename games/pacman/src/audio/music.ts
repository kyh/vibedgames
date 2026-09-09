// Looping background music (vg-generated music-box lullaby), separate from the
// synthesized SFX engine so each file owns one player.

import { isSoundOn } from "./sound-pref";

const MUSIC_TITLE_VOLUME = 0.16;
const MUSIC_PLAY_VOLUME = 0.24;
const MUSIC_POWER_VOLUME = 0.3;
const MUSIC_CHASE_VOLUME = 0.32;
const MUSIC_RESULT_VOLUME = 0.12;
const MUSIC_DUCK_VOLUME = 0.1;
const MUSIC_DUCK_MS = 1400;
/** Power mode plays the lullaby a touch faster — gentle chipmunk urgency. */
const MUSIC_POWER_RATE = 1.06;
/** A ghost this close (maze cells) swells the music; it stays swollen a little further out. */
const CHASE_ENTER_CELLS = 3;
const CHASE_EXIT_CELLS = 4.2;
const CHASE_ENTER_MS = 450;
const CHASE_EXIT_MS = 900;

export type MusicPhase = "title" | "ready" | "playing" | "win" | "gameover";

/**
 * Looping ambient track (vg-generated music-box lullaby). Degrades silently
 * if the file is missing or autoplay is blocked; `start()` is only called
 * after the same gesture that unlocks the Sfx context.
 */
export class Music {
  private audio: HTMLAudioElement | null = null;
  private paused = false;
  private power = false;
  private duckRemaining = 0;
  /** Nearby-ghost tension swell, with hysteresis so it never flutters. */
  private chasing = false;
  private candidateMs = 0;
  private volume = MUSIC_TITLE_VOLUME;
  private phase: MusicPhase = "title";
  /** Only a media error is permanent — a blocked autoplay retries on the next gesture. */
  private failed = false;

  start(url: string): void {
    if (this.failed || !isSoundOn()) {
      return;
    }
    if (!this.audio) {
      const audio = new Audio(url);
      audio.loop = true;
      audio.addEventListener("error", () => {
        this.audio = null;
        this.failed = true;
      });
      this.audio = audio;
    }
    this.sync();
    this.play();
  }

  setPowerMode(on: boolean): void {
    this.power = on;
    this.sync();
  }

  /** Wrapper-requested pause: stop the loop, resumable in place. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.sync();
    if (!paused) {
      this.play();
    }
  }

  /** Dip under the `caught` sting, restored by update(). */
  duck(): void {
    if (this.paused || !isSoundOn()) {
      return;
    }
    this.duckRemaining = MUSIC_DUCK_MS / 1000;
    this.sync();
  }

  /** @param nearestDanger maze-cell distance to a threatening ghost; null while none can. */
  update(dt: number, phase: MusicPhase, nearestDanger: number | null): void {
    if (this.paused) {
      return;
    }
    this.phase = phase;
    if (phase !== "playing" || this.power) {
      this.chasing = false;
      this.candidateMs = 0;
    } else {
      const candidate =
        nearestDanger !== null &&
        nearestDanger < (this.chasing ? CHASE_EXIT_CELLS : CHASE_ENTER_CELLS);
      if (candidate === this.chasing) {
        this.candidateMs = 0;
      } else {
        this.candidateMs += dt * 1000;
        if (this.candidateMs >= (candidate ? CHASE_ENTER_MS : CHASE_EXIT_MS)) {
          this.chasing = candidate;
          this.candidateMs = 0;
        }
      }
    }
    this.duckRemaining = Math.max(0, this.duckRemaining - dt);
    this.volume += (this.targetVolume() - this.volume) * (1 - Math.exp(-dt * 3));
    this.sync();
  }

  /** Push mute/pause/duck/power onto the element; muted or paused also halts it. */
  sync(): void {
    const { audio } = this;
    if (!audio) {
      return;
    }
    const silent = !isSoundOn() || this.paused;
    audio.volume = silent ? 0 : this.currentVolume();
    audio.playbackRate = this.power ? MUSIC_POWER_RATE : 1;
    if (silent) {
      audio.pause();
      this.duckRemaining = 0;
    }
  }

  private currentVolume(): number {
    return this.duckRemaining > 0 ? MUSIC_DUCK_VOLUME : this.volume;
  }

  private play(): void {
    const { audio } = this;
    if (!audio || !isSoundOn() || this.paused || !audio.paused) {
      return;
    }
    void this.playThenSync(audio);
  }

  /** A pause or mute can land while play() is still pending; sync() halts it on settle. */
  private async playThenSync(audio: HTMLAudioElement): Promise<void> {
    try {
      await audio.play();
    } catch {
      // Autoplay blocked or media missing: the next gesture retries.
      return;
    }
    this.sync();
  }

  private targetVolume(): number {
    if (this.phase === "title") {
      return MUSIC_TITLE_VOLUME;
    }
    if (this.phase === "win" || this.phase === "gameover") {
      return MUSIC_RESULT_VOLUME;
    }
    if (this.chasing) {
      return MUSIC_CHASE_VOLUME;
    }
    return this.power ? MUSIC_POWER_VOLUME : MUSIC_PLAY_VOLUME;
  }
}

export const music = new Music();

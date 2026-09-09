// Looping background music (vg-generated music-box lullaby), separate from the
// synthesized SFX engine so each file owns one player.

import { initialSoundOn, SOUND_KEY, storageSet } from "./sound-pref";

const MUSIC_VOLUME = 0.32;
const MUSIC_DUCK_VOLUME = 0.1;
const MUSIC_DUCK_MS = 1400;
/** Power mode plays the lullaby a touch faster — gentle chipmunk urgency. */
const MUSIC_POWER_RATE = 1.06;

/**
 * Looping ambient track (vg-generated music-box lullaby). Degrades silently
 * if the file is missing or autoplay is blocked; `start()` is only called
 * after the same gesture that unlocks the Sfx context.
 */
export class Music {
  private audio: HTMLAudioElement | null = null;
  private enabled = initialSoundOn();
  private duckUntil = 0;
  /** Latched on load/play failure so repeated gestures don't re-request a 404. */
  private failed = false;

  start(url: string): void {
    if (this.audio || this.failed) {
      return;
    }
    const audio = new Audio(url);
    audio.loop = true;
    // Respect a mute toggled before the first unlocking gesture (M can be
    // the very first key pressed — GameScene's handler runs before unlock).
    audio.volume = this.enabled ? MUSIC_VOLUME : 0;
    audio.addEventListener("error", () => {
      this.audio = null;
      this.failed = true;
    });
    this.audio = audio;
    void this.tryPlay(audio, true);
  }

  /** Autoplay can still be refused after the gesture; a refusal on `start`
   *  latches `failed` so repeated gestures don't re-request the file. */
  private async tryPlay(audio: HTMLAudioElement, latchFailure: boolean): Promise<void> {
    try {
      await audio.play();
    } catch {
      if (latchFailure) {
        this.audio = null;
        this.failed = true;
      }
    }
  }

  /** M key. Persists the choice and returns the new state for HUD feedback. */
  toggle(): boolean {
    this.enabled = !this.enabled;
    storageSet(SOUND_KEY, this.enabled ? "1" : "0");
    if (this.audio) {
      this.audio.volume = this.enabled ? MUSIC_VOLUME : 0;
    }
    return this.enabled;
  }

  setPowerMode(on: boolean): void {
    if (this.audio) {
      this.audio.playbackRate = on ? MUSIC_POWER_RATE : 1;
    }
  }

  /** Wrapper-requested pause: stop the loop, resumable in place. */
  pause(): void {
    this.audio?.pause();
  }

  /** Undo pause(). Silently no-ops if autoplay is (still) blocked. */
  resume(): void {
    if (!this.audio) {
      return;
    }
    void this.tryPlay(this.audio, false);
  }

  /** Dip under the `caught` sting, restored by update(). */
  duck(): void {
    if (!this.audio || !this.enabled) {
      return;
    }
    this.duckUntil = performance.now() + MUSIC_DUCK_MS;
    this.audio.volume = MUSIC_DUCK_VOLUME;
  }

  update(): void {
    if (!this.audio || !this.enabled) {
      return;
    }
    if (this.duckUntil > 0 && performance.now() >= this.duckUntil) {
      this.duckUntil = 0;
      this.audio.volume = MUSIC_VOLUME;
    }
  }
}

export const music = new Music();

interface Stamps {
  lastCastAt: number;
  lastAttackAt: number;
}
export interface AnimationEvent {
  kind: "cast" | "attack";
  at: number;
  age: number;
}

/** Consume both accepted edges together. A cast may win this frame, but cannot
 * leave an older attack waiting to restart the character on the next frame. */
export class AnimationEvents {
  private cast = -1;
  private attack = -1;

  observe(stamps: Stamps, now: number): AnimationEvent | null {
    const castChanged = stamps.lastCastAt !== this.cast;
    const attackChanged = stamps.lastAttackAt !== this.attack;
    this.cast = stamps.lastCastAt;
    this.attack = stamps.lastAttackAt;
    const castAge = now - this.cast;
    const attackAge = now - this.attack;
    const cast = castChanged && this.cast > 0 && castAge >= 0 && castAge < 520;
    const attack = attackChanged && this.attack > 0 && attackAge >= 0 && attackAge < 340;
    if (cast && (!attack || this.cast >= this.attack)) {
      return { kind: "cast", at: this.cast, age: castAge };
    }
    if (attack) {
      return { kind: "attack", at: this.attack, age: attackAge };
    }
    return null;
  }
}

/** Late snapshots enter the authored motion at its elapsed point. Remaining
 * ownership uses the original event deadline; playback then follows render dt
 * so intentional hit-stop still slows the character exactly as before. */
export function animationWindow(duration: number, speed: number, event: AnimationEvent) {
  const window = Math.min(2500, Math.max(240, (duration / speed) * 1000));
  return {
    offset: Math.min(duration, (event.age * speed) / 1000),
    remaining: Math.max(0, window - event.age),
    until: event.at + window,
  };
}

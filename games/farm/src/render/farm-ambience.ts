import type Phaser from "phaser";
import { DEPTH } from "../config";
import type { Season } from "../data/calendar";
import type { Weather } from "../systems/weather";

type Mood = "rain" | "snow" | "pollen" | "leaves" | "fireflies" | "clear";
type ActiveMood = Exclude<Mood, "clear">;
interface Mote {
  image: Phaser.GameObjects.Rectangle;
  age: number;
  life: number;
  vx: number;
  vy: number;
  phase: number;
}

interface MoodStyle {
  /** Spawns per second. */
  rate: number;
  /** Seconds a mote lives; rain overrides this from the view height. */
  life: number;
  vy: number;
  w: number;
  h: number;
  color: number;
  alpha: number;
}

const MOOD_STYLE: Record<ActiveMood, MoodStyle> = {
  fireflies: { alpha: 0.35, color: 0xff_ef_ac, h: 1, life: 6, rate: 1.8, vy: -2, w: 1 },
  leaves: { alpha: 0.35, color: 0xdc_a3_58, h: 1.2, life: 6, rate: 2.5, vy: 5, w: 2.5 },
  pollen: { alpha: 0.35, color: 0xff_ef_ac, h: 1, life: 6, rate: 2.5, vy: 5, w: 1 },
  rain: { alpha: 0.45, color: 0xc6_e7_ff, h: 5, life: 0, rate: 70, vy: 190, w: 0.6 },
  snow: { alpha: 0.45, color: 0xf3_f9_ff, h: 1, life: 7, rate: 8, vy: 16, w: 1 },
};

const moodFor = (
  reducedMotion: boolean,
  weather: Weather,
  season: Season,
  timeMin: number,
): Mood => {
  if (reducedMotion) {
    return "clear";
  }
  if (weather === "rain" || weather === "storm") {
    return "rain";
  }
  if (weather === "snow") {
    return "snow";
  }
  if (season === "fall") {
    return "leaves";
  }
  if (timeMin >= 18 * 60 && (season === "spring" || season === "summer")) {
    return "fireflies";
  }
  return season === "spring" ? "pollen" : "clear";
};

/** Camera-local weather. Own random stream, fixed 96 slots; never touches farm state. */
export class FarmAmbience {
  private readonly scene: Phaser.Scene;
  private readonly motes: Mote[];
  private readonly motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private mood: Mood = "clear";
  private cursor = 0;
  private acc = 0;
  private rng = 0x71_64_ac_9d;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.motes = Array.from({ length: 96 }, () => ({
      age: 0,
      image: scene.add
        .rectangle(0, 0, 1, 1, 0xff_ff_ff)
        .setDepth(DEPTH.particles - 1)
        .setVisible(false),
      life: 1,
      phase: 0,
      vx: 0,
      vy: 0,
    }));
  }

  private random(): number {
    // Decoration cannot consume Math.random calls used by yields and fishing.
    // oxlint-disable-next-line no-bitwise -- uint32 wrap for the LCG
    this.rng = (Math.imul(this.rng, 1_664_525) + 1_013_904_223) >>> 0;
    return this.rng / 4_294_967_296;
  }

  update(dt: number, weather: Weather, season: Season, timeMin: number): void {
    const mood = moodFor(this.motion.matches, weather, season, timeMin);
    if (mood !== this.mood) {
      this.mood = mood;
      this.acc = 0;
      for (const mote of this.motes) {
        mote.image.setVisible(false);
      }
    }
    if (mood === "clear") {
      return;
    }
    const view = this.scene.cameras.main.worldView;
    if (view.width <= 0 || view.height <= 0) {
      return;
    }
    this.spawn(dt, mood, view);
    this.advance(dt, mood, view);
  }

  private spawn(dt: number, mood: ActiveMood, view: Phaser.Geom.Rectangle): void {
    const style = MOOD_STYLE[mood];
    const rain = mood === "rain";
    this.acc += dt * style.rate;
    while (this.acc >= 1) {
      this.acc -= 1;
      const mote = this.motes[this.cursor];
      this.cursor = (this.cursor + 1) % this.motes.length;
      if (!mote) {
        continue;
      }
      mote.age = 0;
      mote.life = rain ? view.height / 190 + 0.15 : style.life;
      mote.vx = rain ? -45 : -5 - this.random() * 5;
      mote.vy = style.vy;
      mote.phase = this.random() * Math.PI * 2;
      mote.image
        .setSize(style.w, style.h)
        .setDisplaySize(style.w, style.h)
        .setFillStyle(style.color)
        .setPosition(
          view.x + this.random() * view.width,
          rain ? view.y - 5 : view.y + this.random() * view.height,
        )
        .setAngle(rain ? 14 : 0)
        .setAlpha(0)
        .setVisible(true);
    }
  }

  private advance(dt: number, mood: ActiveMood, view: Phaser.Geom.Rectangle): void {
    const style = MOOD_STYLE[mood];
    const rain = mood === "rain";
    for (const mote of this.motes) {
      if (!mote.image.visible) {
        continue;
      }
      mote.age += dt;
      mote.image.x += (mote.vx + (rain ? 0 : Math.sin(mote.age * 2 + mote.phase) * 4)) * dt;
      mote.image.y += mote.vy * dt;
      if (mood === "leaves") {
        mote.image.angle += dt * 30;
      }
      const t = mote.age / mote.life;
      const glow = mood === "fireflies" ? 0.55 + Math.sin(mote.age * 3 + mote.phase) * 0.3 : 1;
      mote.image.setAlpha(Math.min(1, mote.age * 3, (1 - t) * 3) * style.alpha * glow);
      if (
        t >= 1 ||
        mote.image.x < view.x - 20 ||
        mote.image.x > view.right + 20 ||
        mote.image.y > view.bottom + 12
      ) {
        mote.image.setVisible(false);
      }
    }
  }
}

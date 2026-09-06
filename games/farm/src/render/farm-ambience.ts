import Phaser from "phaser";
import { DEPTH } from "../config";
import type { Season } from "../data/calendar";
import type { Weather } from "../systems/weather";

type Mood = "rain" | "snow" | "pollen" | "leaves" | "fireflies" | "clear";
type Mote = {
  image: Phaser.GameObjects.Rectangle;
  age: number;
  life: number;
  vx: number;
  vy: number;
  phase: number;
};

/** Camera-local weather. Own random stream, fixed 96 slots; never touches farm state. */
export class FarmAmbience {
  private readonly motes: Mote[];
  private readonly motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private mood: Mood = "clear";
  private cursor = 0;
  private acc = 0;
  private rng = 0x7164ac9d;

  constructor(private readonly scene: Phaser.Scene) {
    this.motes = Array.from({ length: 96 }, () => ({
      image: scene.add
        .rectangle(0, 0, 1, 1, 0xffffff)
        .setDepth(DEPTH.particles - 1)
        .setVisible(false),
      age: 0,
      life: 1,
      vx: 0,
      vy: 0,
      phase: 0,
    }));
  }

  private random(): number {
    // Decoration cannot consume Math.random calls used by yields and fishing.
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }

  update(dt: number, weather: Weather, season: Season, timeMin: number): void {
    const mood: Mood = this.motion.matches
      ? "clear"
      : weather === "rain" || weather === "storm"
        ? "rain"
        : weather === "snow"
          ? "snow"
          : season === "fall"
            ? "leaves"
            : timeMin >= 18 * 60 && (season === "spring" || season === "summer")
              ? "fireflies"
              : season === "spring"
                ? "pollen"
                : "clear";
    if (mood !== this.mood) {
      this.mood = mood;
      this.acc = 0;
      for (const mote of this.motes) mote.image.setVisible(false);
    }
    if (mood === "clear") return;
    const view = this.scene.cameras.main.worldView;
    if (view.width <= 0 || view.height <= 0) return;
    const rain = mood === "rain";
    const snow = mood === "snow";
    const rate = rain ? 70 : snow ? 8 : mood === "fireflies" ? 1.8 : 2.5;
    this.acc += dt * rate;
    while (this.acc >= 1) {
      this.acc -= 1;
      const mote = this.motes[this.cursor];
      this.cursor = (this.cursor + 1) % this.motes.length;
      if (!mote) continue;
      mote.age = 0;
      mote.life = rain ? view.height / 190 + 0.15 : snow ? 7 : 6;
      mote.vx = rain ? -45 : -5 - this.random() * 5;
      mote.vy = rain ? 190 : snow ? 16 : mood === "fireflies" ? -2 : 5;
      mote.phase = this.random() * Math.PI * 2;
      const w = rain ? 0.6 : mood === "leaves" ? 2.5 : 1;
      const h = rain ? 5 : mood === "leaves" ? 1.2 : 1;
      const color = rain ? 0xc6e7ff : snow ? 0xf3f9ff : mood === "leaves" ? 0xdca358 : 0xffefac;
      mote.image
        .setSize(w, h)
        .setDisplaySize(w, h)
        .setFillStyle(color)
        .setPosition(
          view.x + this.random() * view.width,
          rain ? view.y - 5 : view.y + this.random() * view.height,
        )
        .setAngle(rain ? 14 : 0)
        .setAlpha(0)
        .setVisible(true);
    }
    for (const mote of this.motes) {
      if (!mote.image.visible) continue;
      mote.age += dt;
      mote.image.x += (mote.vx + (rain ? 0 : Math.sin(mote.age * 2 + mote.phase) * 4)) * dt;
      mote.image.y += mote.vy * dt;
      if (mood === "leaves") mote.image.angle += dt * 30;
      const t = mote.age / mote.life;
      const glow = mood === "fireflies" ? 0.55 + Math.sin(mote.age * 3 + mote.phase) * 0.3 : 1;
      mote.image.setAlpha(
        Math.min(1, mote.age * 3, (1 - t) * 3) * (rain || snow ? 0.45 : 0.35) * glow,
      );
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

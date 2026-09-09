// The centre-screen objective banner: one notice shows at a time, higher
// priorities interrupt, and a small queue holds the rest until they expire.

import Phaser from "phaser";

import type { ObjectiveNotice } from "../scenes/game-scene";
import { FONT } from "./font";
import { reducedMotion } from "./presentation-settings";

const NOTICE_PRIORITY = { ending: 3, major: 2, objective: 1 } satisfies Record<
  ObjectiveNotice["priority"],
  number
>;
const NOTICE_LIFETIME = 14_000;
const SHOW_MS = 3900;
const QUEUE_CAP = 3;

interface Announcement {
  entry: ObjectiveNotice;
  age: number;
  remaining: number;
}

export class AnnouncementBanner {
  private readonly ribbon: Phaser.GameObjects.NineSlice;
  private readonly text: Phaser.GameObjects.Text;
  private active: Announcement | null = null;
  private pending: Announcement[] = [];

  constructor(private readonly scene: Phaser.Scene) {
    this.ribbon = scene.add
      .nineslice(0, 0, "ui-ribbon-blue", 0, 560, 76, 58, 58, 22, 22)
      .setOrigin(0.5)
      .setDepth(45_990)
      .setAlpha(0);
    this.text = scene.add
      .text(0, 0, "", {
        align: "center",
        color: "#ffe6a3",
        fontFamily: FONT,
        fontSize: "26px",
        stroke: "#1e2a3a",
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setDepth(46_000)
      .setAlpha(0);
  }

  queue(entry: ObjectiveNotice, now: number): void {
    const remaining = NOTICE_LIFETIME - Math.max(0, now - entry.at);
    if (remaining <= 0) {
      return;
    }
    const next = { age: 0, entry, remaining };
    if (!this.active) {
      this.active = next;
    } else if (NOTICE_PRIORITY[entry.priority] > NOTICE_PRIORITY[this.active.entry.priority]) {
      this.hold(this.active, true);
      this.active = next;
    } else {
      this.hold(next);
    }
    this.layout();
  }

  private hold(next: Announcement, interrupted = false): void {
    if (
      this.pending.some(
        (p) =>
          p.entry.text === next.entry.text &&
          p.entry.priority === next.entry.priority &&
          p.entry.tone === next.entry.tone,
      )
    ) {
      return;
    }
    if (this.pending.length === QUEUE_CAP) {
      const lowest = Math.min(...this.pending.map((p) => NOTICE_PRIORITY[p.entry.priority]));
      if (NOTICE_PRIORITY[next.entry.priority] < lowest) {
        return;
      }
      const drop = this.pending.findIndex((p) => NOTICE_PRIORITY[p.entry.priority] === lowest);
      this.pending.splice(drop, 1);
    }
    if (interrupted) {
      this.pending.unshift(next);
    } else {
      this.pending.push(next);
    }
  }

  update(delta: number, now: number): void {
    for (const p of this.pending) {
      p.remaining -= delta;
    }
    this.pending = this.pending.filter(
      (p) => p.remaining > 0 && now - p.entry.at < NOTICE_LIFETIME,
    );
    if (this.active) {
      this.active.age += delta;
      this.active.remaining -= delta;
      if (
        this.active.age >= SHOW_MS ||
        this.active.remaining <= 0 ||
        now - this.active.entry.at >= NOTICE_LIFETIME
      ) {
        this.active = null;
      }
    }
    if (!this.active && this.pending.length > 0) {
      const highest = Math.max(...this.pending.map((p) => NOTICE_PRIORITY[p.entry.priority]));
      const index = this.pending.findIndex((p) => NOTICE_PRIORITY[p.entry.priority] === highest);
      this.active = this.pending.splice(index, 1)[0] ?? null;
    }
    this.layout();
  }

  clear(): void {
    this.active = null;
    this.pending = [];
    this.text.setAlpha(0);
    this.ribbon.setAlpha(0);
  }

  layout(): void {
    const { active } = this;
    if (!active) {
      this.text.setAlpha(0);
      this.ribbon.setAlpha(0);
      return;
    }
    const { text, tone } = active.entry;
    const W = this.scene.scale.width;
    const cy = this.scene.scale.height * 0.26;
    const color = tone === "good" ? "#9bf0b4" : tone === "bad" ? "#ffb0a4" : "#fff3c4";
    if (this.text.text !== text) {
      this.text.setText(text);
    }
    if (this.text.style.color !== color) {
      this.text.setColor(color);
    }
    const fit = Math.min(1, (W - 56) / Math.max(1, this.text.width));
    const entrance = reducedMotion()
      ? 1
      : 0.6 + 0.4 * Phaser.Math.Easing.Back.Out(Math.min(1, active.age / 320));
    const alpha = Math.min(1, Math.max(0, (SHOW_MS - active.age) / 700));
    this.text
      .setPosition(W / 2, cy - 4)
      .setScale(fit * entrance)
      .setAlpha(alpha);
    const ribbonWidth = Math.min(W - 8, Math.max(380, this.text.width * fit + 150));
    if (this.ribbon.width !== ribbonWidth) {
      this.ribbon.setSize(ribbonWidth, 76);
    }
    this.ribbon
      .setPosition(W / 2, cy)
      .setScale(entrance)
      .setAlpha(alpha);
  }
}

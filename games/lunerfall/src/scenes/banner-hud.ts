import type Phaser from "phaser";
import type { Scene } from "phaser";

import { BASE_H, BASE_W } from "../config";
import { REDUCED_MOTION } from "../sys/screen";
import type { GameScene } from "./game-scene";

export type BannerKind = "status" | "objective" | "arrival" | "payoff" | "critical" | "connecting";
const BANNER_PRIORITY = {
  arrival: 2,
  connecting: 4,
  critical: 4,
  objective: 1,
  payoff: 3,
  status: 0,
} satisfies Record<BannerKind, number>;
const BANNER_COLORS = {
  arrival: "#ffd15c",
  connecting: "#34e5c8",
  critical: "#f4f7fb",
  objective: "#34e5c8",
  payoff: "#ffd15c",
  status: "#34e5c8",
} satisfies Record<BannerKind, string>;
interface BannerEntry {
  kind: BannerKind;
  text: string;
  hold: number;
  age: number;
}
interface PendingObjective {
  text: string;
  hold: number;
  remaining: number;
}

type BannerCtx = Scene & Pick<GameScene, "lastStand" | "state" | "trailer">;

// Centre-screen cue line: one active banner and one replaceable objective,
// ranked by kind so a payoff never loses to a room label.
export class BannerHud {
  private readonly scene: BannerCtx;
  text!: Phaser.GameObjects.Text;
  active: BannerEntry | null = null;
  pending: PendingObjective | null = null;

  constructor(scene: BannerCtx) {
    this.scene = scene;
  }

  mount() {
    this.text = this.scene.add
      .text(BASE_W / 2, BASE_H / 2 - 20, "", {
        color: "#34e5c8",
        fontFamily: "monospace",
        fontSize: "15px",
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(80)
      .setAlpha(0);
  }

  // One active cue and one replaceable objective. Nothing queues combat or
  // input: only the still-useful exit instruction can wait behind a payoff.
  show(text: string, ms: number, kind: BannerKind) {
    if (
      kind !== "critical" &&
      (this.scene.state === "dead" || this.scene.lastStand.live || this.scene.lastStand.net)
    ) {
      return;
    }
    const { active } = this;
    if (active?.kind === kind && active.text === text) {
      return;
    }
    if (active && BANNER_PRIORITY[kind] < BANNER_PRIORITY[active.kind]) {
      if (kind === "objective" && (active.kind === "arrival" || active.kind === "payoff")) {
        this.pending = { hold: ms, remaining: 3600, text };
      }
      return;
    }
    if (kind === "critical" || kind === "connecting" || kind === "objective") {
      this.pending = null;
    }
    this.begin({ age: 0, hold: ms, kind, text });
  }

  private begin(entry: BannerEntry) {
    this.active = entry;
    this.text
      .setText(entry.kind === "arrival" ? `BOSS ENCOUNTER\n${entry.text}` : entry.text)
      .setWordWrapWidth(BASE_W - 36, true)
      .setAlign("center")
      .setColor(BANNER_COLORS[entry.kind])
      .setAlpha(1)
      .setScale(this.scene.trailer.pinScale);
  }

  // Scene delta advances during hitstop/death/connecting, but freezes when the
  // solo wrapper sleeps the loop. No wall clock, tween callbacks or backlog.
  update(ms: number) {
    if (this.pending) {
      this.pending.remaining -= ms;
      if (this.pending.remaining <= 0) {
        this.pending = null;
      }
    }
    const { active } = this;
    if (!active) {
      return;
    }
    active.age += ms;
    if (active.age >= active.hold + 350) {
      this.active = null;
      this.text.setAlpha(0).setScale(this.scene.trailer.pinScale);
      const { pending } = this;
      this.pending = null;
      if (
        pending &&
        this.scene.state === "active" &&
        !this.scene.lastStand.live &&
        !this.scene.lastStand.net
      ) {
        this.begin({ age: 0, hold: pending.hold, kind: "objective", text: pending.text });
      }
      return;
    }
    const alpha = active.age <= active.hold ? 1 : 1 - (active.age - active.hold) / 350;
    const settle =
      active.kind === "arrival" && !REDUCED_MOTION.matches
        ? 1 + 0.04 * Math.max(0, 1 - active.age / 180)
        : 1;
    this.text.setAlpha(alpha).setScale(this.scene.trailer.pinScale * settle);
  }

  clear() {
    this.active = null;
    this.pending = null;
    this.text.setAlpha(0).setScale(this.scene.trailer.pinScale);
  }
}

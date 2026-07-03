// Contextual hint engine — replaces the onboarding wall-of-text with one-shot,
// ≤8-word hints that fire off synced-state reads only. One hint visible at a
// time, 4s display, ≥5s gap between hints, each rule shows once (shop600
// re-arms once at 1200g). DOM-free: the `show` callback renders (empty string
// = hide); `isTouch` swaps in touch wording at display time.
//
// Wiring (Wave 2): owned by Hud, `update(w, me)` called from Hud.update; the
// shop-open handler calls `notifyShopOpened()` to dismiss the shop hint early.
import { CAMPS, isInThrone } from "../data/map";
import type { Unit, World } from "../sim/types";

const INTRO_S = 2.4; // solo fly-in length (view.startIntro) — move hint waits for it
const SHOW_S = 4; // hint display time
const GAP_S = 5; // minimum quiet time between hints

type HintState = {
  spawnX: number;
  spawnY: number;
  spawnSet: boolean;
  everInThrone: boolean;
  shopRearmed: boolean;
};

type Rule = {
  id: string;
  text: string;
  touch: string;
  when(w: World, me: Unit, st: HintState): boolean;
  /** Early-dismiss (and "already learned — never show") condition. */
  done?(w: World, me: Unit, st: HintState): boolean;
};

function enemyWithin(w: World, me: Unit, r: number): boolean {
  const r2 = r * r;
  for (const u of w.units.values()) {
    if (!u.alive || u.team === me.team) continue;
    if (u.kind !== "hero" && u.kind !== "creep") continue;
    const dx = u.x - me.x;
    const dy = u.y - me.y;
    if (dx * dx + dy * dy < r2) return true;
  }
  return false;
}

function nearAnyCamp(me: Unit, r: number): boolean {
  const r2 = r * r;
  for (const c of CAMPS) {
    const dx = c.x - me.x;
    const dy = c.y - me.y;
    if (dx * dx + dy * dy < r2) return true;
  }
  return false;
}

const RULES: Rule[] = [
  {
    id: "move",
    text: "WASD move · mouse aim",
    touch: "Left stick move · right stick aim",
    when: (w) => w.gameTime > INTRO_S + 0.5,
    done: (_w, me, st) => st.spawnSet && (me.x - st.spawnX) ** 2 + (me.y - st.spawnY) ** 2 > 25,
  },
  {
    id: "attack",
    text: "Left click — attack",
    touch: "Right stick — auto attack",
    when: (w, me) => enemyWithin(w, me, 12),
    done: (_w, me) => me.lastAttackAt > 0,
  },
  {
    id: "ability",
    text: "Press 1 — ability",
    touch: "Tap 1 — ability",
    when: (w, me) => w.gameTime > 12 && me.abilities.Q.rank >= 1 && me.abilities.Q.readyAt <= w.now,
    done: (_w, me) => me.lastCastAt > 0,
  },
  {
    id: "camp",
    text: "Skeletons drop gold",
    touch: "Skeletons drop gold",
    when: (_w, me) => nearAnyCamp(me, 16),
  },
  {
    id: "coin",
    text: "Golem threw gold — grab it",
    touch: "Golem threw gold — grab it",
    when: (w) => w.coins.length > 0,
    done: (w) => w.coins.length === 0,
  },
  {
    id: "delivery",
    text: "Green pad — free item",
    touch: "Green pad — free item",
    when: (w) => w.deliveries.length > 0,
  },
  {
    id: "shop600",
    text: "600 gold — press B at base",
    touch: "600 gold — tap B at base",
    when: (_w, me) => me.gold >= 600 && me.items.length === 0,
    done: (_w, me) => me.items.length > 0,
  },
  {
    id: "throne",
    text: "Hold the throne — bonus gold",
    touch: "Hold the throne — bonus gold",
    when: (w, _me, st) => w.gameTime > 30 && !st.everInThrone,
    done: (_w, _me, st) => st.everInThrone,
  },
  {
    id: "dash",
    text: "Shift — dash (brief i-frames)",
    touch: "Tap DASH — quick dodge",
    when: (_w, me) => me.deaths === 2 && me.alive,
    done: (_w, me) => me.lastCastKey === "DASH",
  },
  {
    id: "jump",
    text: "Space then click — jump attack",
    touch: "Tap JUMP↯ — leaping strike",
    when: (w, me) => w.gameTime > 40 && me.alive,
    done: (_w, me) => me.lastCastKey === "JUMP",
  },
];

export class Hints {
  private readonly shown = new Set<string>();
  private visible: Rule | null = null;
  private visibleUntil = 0; // gameTime s
  private nextAt = 0; // gameTime s — earliest next hint
  private lastT = 0;
  private readonly st: HintState = {
    spawnX: 0,
    spawnY: 0,
    spawnSet: false,
    everInThrone: false,
    shopRearmed: false,
  };

  constructor(
    private readonly isTouch: () => boolean,
    private readonly show: (text: string) => void,
  ) {}

  /** Call every frame with the synced world + the local unit (null pre-spawn). */
  update(w: World, me: Unit | null): void {
    if (!me) return;
    const t = w.gameTime;
    this.lastT = t;
    if (!this.st.spawnSet && me.alive) {
      this.st.spawnX = me.x;
      this.st.spawnY = me.y;
      this.st.spawnSet = true;
    }
    if (!this.st.everInThrone && isInThrone(me.x, me.y)) this.st.everInThrone = true;

    // shop600 re-arms exactly once, at 1200g with a still-empty inventory
    if (
      !this.st.shopRearmed &&
      this.shown.has("shop600") &&
      this.visible?.id !== "shop600" &&
      me.gold >= 1200 &&
      me.items.length === 0
    ) {
      this.shown.delete("shop600");
      this.st.shopRearmed = true;
    }

    if (this.visible) {
      const r = this.visible;
      if (t >= this.visibleUntil || (r.done !== undefined && r.done(w, me, this.st))) this.hide();
      return;
    }
    if (t < this.nextAt) return;

    for (const r of RULES) {
      if (this.shown.has(r.id)) continue;
      // already learned before we could teach it — retire silently
      if (r.done !== undefined && r.done(w, me, this.st)) {
        this.shown.add(r.id);
        continue;
      }
      if (!r.when(w, me, this.st)) continue;
      this.shown.add(r.id);
      this.visible = r;
      this.visibleUntil = t + SHOW_S;
      this.show(this.isTouch() ? r.touch : r.text);
      return;
    }
  }

  /** Early-dismiss hook for the one trigger the sim can't see (Hud shop open). */
  notifyShopOpened(): void {
    if (this.visible?.id === "shop600") this.hide();
  }

  private hide(): void {
    this.visible = null;
    this.nextAt = this.lastT + GAP_S;
    this.show("");
  }
}

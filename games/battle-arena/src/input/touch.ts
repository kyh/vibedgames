// Twin-stick touch controls (build-doc §12). Left half = floating move stick;
// right half = floating aim stick that auto-fires while held. Fixed bottom-right
// button grid: Q/W/E · R/DASH/JUMP · hop/B. DASH casts the hero's dash, JUMP the
// leaping strike (self-leaps if grounded); the hop button is the plain Space hop.
// Ability buttons take champ icon backgrounds via bindChamp() and per-button
// conic cooldown sweeps via setCooldown(). Pre-shows on coarse-pointer devices,
// otherwise activates on first touch; idle on desktop. The full-screen layer is
// pointer-events:none (sticks listen on window) so interactive HUD stays tappable.
import { abilityIcon } from "../data/icons";
import type { AbilityKey } from "../sim/types";

type Stick = { id: number; baseX: number; baseY: number; dx: number; dy: number };

const STICK_R = 60;
const KNOB_R = 28;

// "DASH"/"JUMP" are AbilityKeys → their buttons carry cooldown sweeps and icons
// like Q/W/E/R. "J" is the plain hop (Space), "B" the shop toggle.
type BtnId = AbilityKey | "B" | "J";
const BTN_KEYS: { id: BtnId; label: string }[] = [
  { id: "Q", label: "1" },
  { id: "W", label: "2" },
  { id: "E", label: "3" },
  { id: "R", label: "4" },
  { id: "DASH", label: "DASH" },
  { id: "JUMP", label: "JUMP↯" },
  { id: "J", label: "HOP" },
  { id: "B", label: "B" },
];
const ABILITY_IDS = new Set<string>(["Q", "W", "E", "R", "DASH", "JUMP"]);

// Touches that begin on interactive HUD (shop/end buttons, belt chips, the
// tappable timer) belong to that UI — they must never spawn a stick.
const INTERACTIVE_SEL = "button,input,#ba-shop,#ba-end,#ba-timer,.ba-item-chip";

type Btn = {
  el: HTMLDivElement;
  label: HTMLSpanElement;
  cd: HTMLDivElement | null;
  lastCd: number;
};

export class TouchControls {
  active = false;
  private move: Stick | null = null;
  private aim: Stick | null = null;
  private queue: AbilityKey[] = [];
  private buy = false;
  private jump = false; // plain hop (Space)
  private dash = false; // cast DASH
  private jumpAttack = false; // cast JUMP (leaping strike)
  private layer: HTMLDivElement;
  private moveEl: HTMLDivElement;
  private aimEl: HTMLDivElement;
  private buttons = new Map<string, Btn>();
  private champBound = "";

  constructor() {
    injectTouchStyle();
    this.layer = document.createElement("div");
    this.layer.id = "ba-touch";
    // pointer-events:none — the layer must never eat HUD taps (shop, end card,
    // belt chips); sticks work off window-level listeners, the pad re-enables auto
    this.layer.style.cssText =
      "position:fixed;inset:0;z-index:7;display:none;touch-action:none;pointer-events:none";
    this.moveEl = stickEl();
    this.aimEl = stickEl();
    this.layer.append(this.moveEl, this.aimEl);

    const pad = document.createElement("div");
    pad.style.cssText =
      "position:fixed;right:calc(16px + env(safe-area-inset-right));bottom:calc(20px + env(safe-area-inset-bottom));display:grid;grid-template-columns:repeat(3,58px);grid-auto-rows:58px;gap:8px;pointer-events:auto";
    for (const b of BTN_KEYS) {
      const el = document.createElement("div");
      el.className = "ba-tbtn";
      // B rides the right-most column of the third row so that row (HOP · B)
      // never reaches over the item belt pinned bottom-left on phones.
      if (b.id === "B") el.style.gridColumn = "3";
      const label = document.createElement("span");
      label.className = "ba-tl";
      label.textContent = b.label;
      if (b.label.length > 1) label.classList.add("word");
      el.appendChild(label);
      let cd: HTMLDivElement | null = null;
      if (ABILITY_IDS.has(b.id)) {
        cd = document.createElement("div");
        cd.className = "ba-tcd";
        el.appendChild(cd);
      }
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        el.classList.add("press");
        if (b.id === "B") this.buy = true;
        else if (b.id === "J") this.jump = true;
        else if (b.id === "DASH") this.dash = true;
        else if (b.id === "JUMP") this.jumpAttack = true;
        else this.queue.push(b.id);
      });
      el.addEventListener("pointerup", () => el.classList.remove("press"));
      el.addEventListener("pointercancel", () => el.classList.remove("press"));
      this.buttons.set(b.id, { el, label, cd, lastCd: -1 });
      pad.appendChild(el);
    }
    this.layer.appendChild(pad);
    document.body.appendChild(this.layer);

    window.addEventListener("pointerdown", this.onDown, { passive: false });
    window.addEventListener("pointermove", this.onMove, { passive: false });
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);

    // pre-show on touch-first devices so the pad is visible from spawn and the
    // hint engine speaks touch from boot (not only after the first touch)
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer:coarse)").matches) {
      this.activate();
    }
  }

  /** Paint the local champ's ability icons onto Q/W/E/R and demote the digit
   *  labels to corner keycaps. DASH/JUMP get the shared glyph icon (abilityIcon
   *  special-cases them) but keep their word label. Idempotent per champ. */
  bindChamp(champId: string): void {
    if (champId === this.champBound) return;
    this.champBound = champId;
    for (const key of ["Q", "W", "E", "R", "DASH", "JUMP"] as AbilityKey[]) {
      const btn = this.buttons.get(key);
      if (!btn) continue;
      btn.el.style.backgroundImage = `url("${abilityIcon(champId, key)}")`;
      if (key === "Q" || key === "W" || key === "E" || key === "R") btn.label.classList.add("kc");
    }
  }

  /** Per-button conic cooldown sweep. `pct` = fraction of cooldown remaining
   *  (0 = ready, 1 = just cast). Change-gated to whole-percent writes. */
  setCooldown(key: AbilityKey, pct: number): void {
    const btn = this.buttons.get(key);
    if (!btn || !btn.cd) return;
    const v = Math.round(Math.max(0, Math.min(1, pct)) * 100);
    if (v === btn.lastCd) return;
    btn.lastCd = v;
    btn.cd.style.setProperty("--cd", `${v}`);
  }

  private activate(): void {
    if (this.active) return;
    this.active = true;
    this.layer.style.display = "block";
    document.body.classList.add("ba-touch-on");
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") return;
    this.activate();
    // the layer is pointer-events:none, so e.target is the real element under
    // the finger — interactive HUD wins over stick spawning
    const t = e.target;
    if (t instanceof Element && t.closest(INTERACTIVE_SEL)) return;
    // menus own the pointer (shop / end screen — Controls.setMouseMode): taps
    // there browse UI, they never steer or auto-fire
    if (document.body.classList.contains("ba-mouse-mode")) return;
    // cancel compat mouse events so a stick touch never mousedown's the canvas
    // (that path requests pointer lock + fires LMB attacks on desktop)
    e.preventDefault();
    if (e.clientX < window.innerWidth / 2) {
      if (!this.move)
        this.move = { id: e.pointerId, baseX: e.clientX, baseY: e.clientY, dx: 0, dy: 0 };
    } else if (!this.aim) {
      this.aim = { id: e.pointerId, baseX: e.clientX, baseY: e.clientY, dx: 0, dy: 0 };
    }
    this.render();
  };

  private onMove = (e: PointerEvent): void => {
    const s =
      this.move?.id === e.pointerId ? this.move : this.aim?.id === e.pointerId ? this.aim : null;
    if (!s) return;
    const dx = e.clientX - s.baseX;
    const dy = e.clientY - s.baseY;
    const len = Math.hypot(dx, dy) || 1;
    const clamp = Math.min(len, STICK_R) / STICK_R;
    s.dx = (dx / len) * clamp;
    s.dy = (dy / len) * clamp;
    this.render();
  };

  private onUp = (e: PointerEvent): void => {
    if (this.move?.id === e.pointerId) this.move = null;
    if (this.aim?.id === e.pointerId) this.aim = null;
    this.render();
  };

  private render(): void {
    place(this.moveEl, this.move);
    place(this.aimEl, this.aim);
  }

  moveVec(): { x: number; y: number } {
    return this.move ? { x: this.move.dx, y: this.move.dy } : { x: 0, y: 0 };
  }
  /** Aim direction (unit-ish) or null if the right stick isn't held. */
  aimVec(): { x: number; y: number } | null {
    if (!this.aim) return null;
    const l = Math.hypot(this.aim.dx, this.aim.dy);
    if (l < 0.2) return null;
    return { x: this.aim.dx / l, y: this.aim.dy / l };
  }
  attackDown(): boolean {
    return this.aim !== null && Math.hypot(this.aim.dx, this.aim.dy) > 0.2;
  }
  consumeAbilities(): AbilityKey[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
  consumeBuy(): boolean {
    const b = this.buy;
    this.buy = false;
    return b;
  }
  consumeJump(): boolean {
    const j = this.jump;
    this.jump = false;
    return j;
  }
  /** Edge: DASH button pressed (cast the hero's dash). */
  consumeDash(): boolean {
    const d = this.dash;
    this.dash = false;
    return d;
  }
  /** Edge: JUMP button pressed (cast the leaping strike; self-leaps if grounded). */
  consumeJumpAttack(): boolean {
    const j = this.jumpAttack;
    this.jumpAttack = false;
    return j;
  }
}

let touchStyleInjected = false;
function injectTouchStyle(): void {
  if (touchStyleInjected) return;
  touchStyleInjected = true;
  const s = document.createElement("style");
  s.textContent = `
.ba-tbtn{position:relative;width:58px;height:58px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(20,26,42,.7);border:2px solid rgba(255,255,255,.25);color:#fff;overflow:hidden;background-size:cover;background-position:center;touch-action:none}
.ba-tbtn.press{filter:brightness(1.6);border-color:rgba(255,209,71,.8)}
.ba-tbtn .ba-tl{font:800 18px ui-monospace,monospace;pointer-events:none}
.ba-tbtn .ba-tl.word{font-size:11px;letter-spacing:.5px}
.ba-tbtn .ba-tl.kc{position:absolute;right:6px;bottom:4px;font:800 10px/14px ui-monospace,monospace;color:#ffd24a;background:rgba(5,8,16,.85);border-radius:4px;padding:0 4px}
.ba-tcd{position:absolute;inset:0;border-radius:50%;background:conic-gradient(rgba(5,8,16,.75) calc(var(--cd,0)*1%),transparent 0);pointer-events:none}
`;
  document.head.appendChild(s);
}

function stickEl(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;display:none;pointer-events:none`;
  el.innerHTML = `<div class="base"></div><div class="knob"></div>`;
  const base = el.querySelector(".base") as HTMLDivElement;
  const knob = el.querySelector(".knob") as HTMLDivElement;
  base.style.cssText = `position:absolute;width:${STICK_R * 2}px;height:${STICK_R * 2}px;border-radius:50%;background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.2);transform:translate(-50%,-50%)`;
  knob.style.cssText = `position:absolute;width:${KNOB_R * 2}px;height:${KNOB_R * 2}px;border-radius:50%;background:rgba(255,255,255,.35);transform:translate(-50%,-50%)`;
  return el;
}

function place(el: HTMLDivElement, s: Stick | null): void {
  if (!s) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  const base = el.firstElementChild as HTMLDivElement;
  const knob = el.lastElementChild as HTMLDivElement;
  base.style.left = `${s.baseX}px`;
  base.style.top = `${s.baseY}px`;
  knob.style.left = `${s.baseX + s.dx * STICK_R}px`;
  knob.style.top = `${s.baseY + s.dy * STICK_R}px`;
}

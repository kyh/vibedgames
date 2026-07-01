// Twin-stick touch controls (build-doc §12). Left half = floating move stick;
// right half = floating aim stick that auto-fires while held. Ability buttons
// (Q / W / E / R) + shop are fixed bottom-right. Activates on first touch;
// stays out of the way on desktop.
import type { AbilityKey } from "../sim/types";

type Stick = { id: number; baseX: number; baseY: number; dx: number; dy: number };

const STICK_R = 60;
const KNOB_R = 28;
const BTN_KEYS: { id: AbilityKey | "B"; label: string }[] = [
  { id: "Q", label: "SP" },
  { id: "W", label: "2" },
  { id: "E", label: "3" },
  { id: "R", label: "4" },
  { id: "B", label: "B" },
];

export class TouchControls {
  active = false;
  private move: Stick | null = null;
  private aim: Stick | null = null;
  private queue: AbilityKey[] = [];
  private buy = false;
  private layer: HTMLDivElement;
  private moveEl: HTMLDivElement;
  private aimEl: HTMLDivElement;
  private buttons = new Map<string, HTMLDivElement>();

  constructor() {
    this.layer = document.createElement("div");
    this.layer.id = "ba-touch";
    this.layer.style.cssText = "position:fixed;inset:0;z-index:7;display:none;touch-action:none";
    this.moveEl = stickEl();
    this.aimEl = stickEl();
    this.layer.append(this.moveEl, this.aimEl);

    const pad = document.createElement("div");
    pad.style.cssText =
      "position:fixed;right:calc(16px + env(safe-area-inset-right));bottom:calc(20px + env(safe-area-inset-bottom));display:grid;grid-template-columns:repeat(3,58px);grid-auto-rows:58px;gap:8px;pointer-events:auto";
    for (const b of BTN_KEYS) {
      const el = document.createElement("div");
      el.className = "ba-tbtn";
      el.textContent = b.label;
      el.style.cssText =
        "width:58px;height:58px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(20,26,42,.7);border:2px solid rgba(255,255,255,.25);font:800 18px ui-monospace,monospace;color:#fff";
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        el.style.background = "rgba(255,209,71,.4)";
        if (b.id === "B") this.buy = true;
        else this.queue.push(b.id);
      });
      el.addEventListener("pointerup", () => (el.style.background = "rgba(20,26,42,.7)"));
      this.buttons.set(b.id, el);
      pad.appendChild(el);
    }
    this.layer.appendChild(pad);
    document.body.appendChild(this.layer);

    window.addEventListener("pointerdown", this.onDown, { passive: false });
    window.addEventListener("pointermove", this.onMove, { passive: false });
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);
  }

  private activate(): void {
    if (this.active) return;
    this.active = true;
    this.layer.style.display = "block";
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") return;
    this.activate();
    if (e.clientX < window.innerWidth / 2) {
      if (!this.move) this.move = { id: e.pointerId, baseX: e.clientX, baseY: e.clientY, dx: 0, dy: 0 };
    } else if (!this.aim) {
      this.aim = { id: e.pointerId, baseX: e.clientX, baseY: e.clientY, dx: 0, dy: 0 };
    }
    this.render();
  };

  private onMove = (e: PointerEvent): void => {
    const s = this.move?.id === e.pointerId ? this.move : this.aim?.id === e.pointerId ? this.aim : null;
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

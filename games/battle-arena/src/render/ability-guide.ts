import { PhysicalGamepad } from "@vibedgames/gamepad";
import { CHAMP_BY_ID, valAt } from "../data/champions";
import { abilityIcon } from "../data/icons";
import { ALL_ABILITY_KEYS, type AbilityKey, type Unit } from "../sim/types";

const KEYS = {
  Q: "1",
  W: "2",
  E: "3",
  R: "4",
  DASH: "Shift",
  JUMP: "Space + attack",
} satisfies Record<AbilityKey, string>;
const TARGETS = {
  direction: "Aim with mouse or right stick.",
  ground: "Aim at the ground ahead of you.",
  self: "Affects you or the area around you.",
  dash: "Moves along your aim direction.",
  passive: "Always active once unlocked.",
};

/** A native modal owns inspection input; the arena clock keeps running. */
export class AbilityGuide {
  private readonly dialog = document.createElement("dialog");
  private readonly title = document.createElement("h2");
  private readonly tabs = document.createElement("div");
  private readonly copy = document.createElement("div");
  private readonly closeButton = document.createElement("button");
  private readonly pad = new PhysicalGamepad();
  private readonly buttons = new Map<AbilityKey, HTMLButtonElement>();
  private champion = "";
  private selected: AbilityKey = "Q";
  private unit: Unit | null = null;
  private shownRank = -1;
  private returnFocus: HTMLElement | null = null;
  private disposed = false;
  private closingKey: string | null = null;

  constructor(private readonly onChange: (open: boolean) => void) {
    this.dialog.className = "ba-kit-guide";
    this.dialog.setAttribute("aria-label", "Champion abilities");
    const header = document.createElement("div");
    header.className = "ba-kit-header";
    this.closeButton.type = "button";
    this.closeButton.textContent = "Close";
    this.closeButton.addEventListener("click", () => this.close());
    header.append(this.title, this.closeButton);
    this.tabs.className = "ba-kit-tabs";
    this.copy.className = "ba-kit-copy";
    for (const key of ALL_ABILITY_KEYS) {
      const button = document.createElement("button");
      button.type = "button";
      button.addEventListener("click", () => this.select(key));
      this.buttons.set(key, button);
      this.tabs.append(button);
    }
    this.dialog.append(header, this.tabs, this.copy);
    for (const name of ["pointerdown", "pointermove", "pointerup", "pointercancel"])
      this.dialog.addEventListener(name, (event) => event.stopPropagation());
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    document.body.append(this.dialog);
    ensureStyle();
  }

  get open(): boolean {
    return this.dialog.open;
  }

  show(champion: string, unit: Unit | null = null): void {
    if (this.disposed || this.open || !CHAMP_BY_ID[champion]) return;
    this.champion = champion;
    this.unit = unit;
    this.returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.title.textContent = `${CHAMP_BY_ID[champion]?.name ?? "Champion"} · Kit`;
    for (const [key, button] of this.buttons) {
      const ability = CHAMP_BY_ID[champion]?.abilities[key];
      const icon = document.createElement("img");
      icon.src = abilityIcon(champion, key);
      icon.alt = "";
      const label = document.createElement("span");
      label.textContent = KEYS[key];
      button.replaceChildren(icon, label);
      button.setAttribute("aria-label", `Inspect ${KEYS[key]}: ${ability?.name ?? key}`);
    }
    this.select("Q");
    this.pad.update();
    this.pad.update();
    this.onChange(true);
    this.dialog.showModal();
    this.closeButton.focus();
  }

  private select(key: AbilityKey): void {
    const ability = CHAMP_BY_ID[this.champion]?.abilities[key];
    if (!ability) return;
    this.selected = key;
    for (const [id, button] of this.buttons)
      button.setAttribute("aria-pressed", String(id === key));
    const rank = this.unit?.abilities[key].rank ?? 1;
    this.shownRank = rank;
    const heading = document.createElement("h3");
    heading.textContent = ability.name;
    const description = document.createElement("p");
    description.textContent = ability.desc;
    const targeting = document.createElement("p");
    targeting.textContent = TARGETS[ability.targeting];
    const facts = document.createElement("p");
    facts.className = "ba-kit-facts";
    facts.textContent = `${rank > 0 ? `Rank ${rank}` : "Unlocks at level 4"} · ${valAt(ability.cooldown, Math.max(1, rank))}s cooldown`;
    const note = document.createElement("p");
    note.className = "ba-kit-note";
    note.textContent = this.unit
      ? "Inspecting only. The match continues."
      : "Choose a champion, then try the kit against bots.";
    this.copy.replaceChildren(heading, description, targeting, facts, note);
  }

  update(unit?: Unit | null): void {
    if (!this.open || this.disposed) return;
    if (unit !== undefined) this.unit = unit;
    if ((this.unit?.abilities[this.selected].rank ?? 1) !== this.shownRank)
      this.select(this.selected);
    this.pad.update();
    if (this.pad.justPressed("b") || this.pad.justPressed("start") || this.pad.justPressed("ls")) {
      this.close();
      return;
    }
    const direction =
      this.pad.justPressed("left") || this.pad.justPressed("lb")
        ? -1
        : this.pad.justPressed("right") || this.pad.justPressed("rb")
          ? 1
          : 0;
    if (direction) {
      const key =
        ALL_ABILITY_KEYS[
          (ALL_ABILITY_KEYS.indexOf(this.selected) + direction + ALL_ABILITY_KEYS.length) %
            ALL_ABILITY_KEYS.length
        ];
      if (key) {
        this.select(key);
        this.buttons.get(key)?.focus();
      }
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.open || event.code === "KeyM") return;
    event.stopPropagation();
    if (event.code === "Escape" || event.code === "KeyH") {
      event.preventDefault();
      this.closingKey = event.code;
      this.close();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "KeyM") return;
    if (this.open || this.closingKey === event.code) event.stopPropagation();
    if (this.closingKey === event.code) this.closingKey = null;
  };

  close(): void {
    if (!this.open) return;
    this.dialog.close();
    this.onChange(false);
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    this.pad.destroy();
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    this.dialog.remove();
  }
}

function ensureStyle(): void {
  if (document.getElementById("ba-kit-style")) return;
  const style = document.createElement("style");
  style.id = "ba-kit-style";
  style.textContent = `
.ba-kit-guide{box-sizing:border-box;width:min(560px,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:16px;border:1px solid #a58a42;border-radius:14px;background:#111722;color:#f4efd9;font:14px/1.5 ui-monospace,monospace;box-shadow:0 18px 65px #000b;overflow:auto;overscroll-behavior:contain;touch-action:pan-y}
.ba-kit-guide::backdrop{background:#030710b8}
.ba-kit-header{display:flex;justify-content:space-between;align-items:center;gap:12px}
.ba-kit-header h2{font:800 18px/1.2 ui-monospace,monospace;margin:0;color:#ffd24a}
.ba-kit-guide button{min-width:44px;min-height:44px;border:1px solid #647080;border-radius:8px;background:#1c2637;color:#fff;font:700 12px ui-monospace,monospace;cursor:pointer}
.ba-kit-guide button:focus-visible{outline:3px solid #ffd24a;outline-offset:2px}
.ba-kit-tabs{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;margin:16px 0 12px}
.ba-kit-tabs button{display:flex;flex-direction:column;align-items:center;padding:6px 2px;gap:4px}
.ba-kit-tabs img{width:32px;height:32px;border-radius:5px}
.ba-kit-tabs span{font-size:10px;line-height:1.2}
.ba-kit-tabs [aria-pressed=true]{border-color:#ffd24a;background:#3d3522}
.ba-kit-copy h3{font-size:18px;color:#ffd24a;margin:8px 0}
.ba-kit-copy p{margin:10px 0}.ba-kit-facts{color:#b9dcff}.ba-kit-note{font-size:11px;color:#b8c0cf}
@media(max-height:480px){.ba-kit-guide{padding:12px}.ba-kit-tabs{margin:8px 0}.ba-kit-tabs img{width:24px;height:24px}.ba-kit-copy p{margin:6px 0}}
`;
  document.head.append(style);
}

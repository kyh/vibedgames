// The native ability guide: a DOM toggle + dialog beside the HUD that explains
// the local hero's kit. DOM rather than Phaser so it scrolls, wraps and is
// reachable by keyboard/screen reader; ability buttons keep their cast action.

import { HERO_BY_ID } from "../data/heroes";
import type { AbilityKey } from "../data/heroes";
import type { GameScene } from "../scenes/game-scene";
import { FONT } from "./font";
import { abilityExplanation, experienceProgress } from "./hud-presentation";

const KEYS: AbilityKey[] = ["Q", "W", "E", "R"];

const CSS = `
  .moba-ability-guide{position:fixed;inset:0;z-index:90;pointer-events:none;color:#352c22}
  .moba-ability-guide[data-open=true]{pointer-events:auto}
  .moba-ability-guide [hidden]{display:none!important}
  .moba-ability-guide button{min-height:44px;border:1px solid #786044;border-radius:2px;background:#ead7ae;color:#352c22;font:14px ${FONT};cursor:pointer}
  .moba-ability-guide button:focus-visible,.moba-ability-guide .guide-copy:focus-visible{outline:3px solid #164f62;outline-offset:2px}
  .moba-ability-guide button[aria-pressed=true]{background:#325c69;color:#fff2ce;border-color:#203b43}
  .moba-ability-guide .guide-toggle{position:absolute;width:112px;pointer-events:auto;background:#d4bb8c url(assets/ui/carved3.webp) center/100% 100% no-repeat;border:0}
  .moba-ability-guide section{position:absolute;box-sizing:border-box;pointer-events:auto;display:flex;flex-direction:column;border:3px solid #786044;border-radius:3px;background:#e6d2a9;box-shadow:0 4px 0 #352c2260;overflow:hidden}
  .moba-ability-guide header{display:flex;flex-shrink:0;align-items:center;gap:8px;padding:7px 10px 0}
  .moba-ability-guide .guide-heading{flex:1;min-width:0}
  .moba-ability-guide h2{margin:0;font:19px ${FONT}}
  .moba-ability-guide .guide-close{flex:none;width:44px;font-size:20px}
  .moba-ability-guide .guide-xp{margin:3px 0;font:12px system-ui,sans-serif;color:#5d482d}
  .moba-ability-guide nav{display:flex;flex-shrink:0;gap:6px;padding:6px 10px 8px}
  .moba-ability-guide nav button{flex:1}
  .moba-ability-guide .guide-copy{min-height:0;padding:0 12px 12px;overflow:auto;overscroll-behavior:contain;touch-action:pan-y;font:15px/1.4 system-ui,sans-serif}
  .moba-ability-guide h3{margin:0 0 5px;font:20px ${FONT}}
  .moba-ability-guide p{margin:6px 0}
  .moba-ability-guide .guide-rank,.moba-ability-guide .guide-costs,.moba-ability-guide .guide-unlock{font-size:13px;color:#5d482d}
  .moba-ability-guide .guide-unlock{border-top:1px solid #bca177;padding-top:8px}
  .moba-ability-guide .guide-more{height:16px;flex:none;margin:0;text-align:center;font:11px/16px system-ui,sans-serif;color:#70532e;pointer-events:none;visibility:hidden}
  @media(max-width:759px),(max-height:519px){
    .moba-ability-guide header{padding:4px 8px 2px}
    .moba-ability-guide h2{font-size:17px;line-height:1.05}
    .moba-ability-guide .guide-xp{margin:2px 0;font-size:11px}
    .moba-ability-guide nav{gap:4px;padding:0 8px 4px}
    .moba-ability-guide .guide-copy{padding:0 10px 8px;font-size:13px;line-height:1.35}
    .moba-ability-guide h3{font-size:17px;line-height:1.1;margin-bottom:4px}
    .moba-ability-guide .guide-copy p{margin:4px 0}
    .moba-ability-guide .guide-rank,.moba-ability-guide .guide-costs,.moba-ability-guide .guide-unlock{font-size:12px}
  }
`;

export interface GuidePlacement {
  x: number;
  y: number;
  toggleWidth: number;
  panelWidth: number;
  maxHeight: number;
}

export interface AbilityGuideOptions {
  /** Another HUD panel (shop/scoreboard) is up: the toggle stays inert and the guide hides. */
  blocked: () => boolean;
  onOpen: () => void;
  onClose: () => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text) {
    node.textContent = text;
  }
  return node;
};

const button = (className: string, text: string): HTMLButtonElement => {
  const node = el("button", className, text);
  node.type = "button";
  return node;
};

export class AbilityGuide {
  private readonly root = el("div", "moba-ability-guide");
  private readonly style = el("style");
  private readonly toggle = button("guide-toggle", "ABILITIES");
  private readonly panel = el("section");
  private readonly close = button("guide-close", "×");
  private readonly title = el("h2");
  private readonly experience = el("p", "guide-xp");
  private readonly tabs = KEYS.map((key) => ({ button: button("", key), key }));
  private readonly copy = el("div", "guide-copy");
  private readonly name = el("h3");
  private readonly rank = el("p", "guide-rank");
  private readonly description = el("p");
  private readonly costs = el("p", "guide-costs");
  private readonly unlock = el("p", "guide-unlock");
  private readonly more = el("p", "guide-more", "Scroll for more ↓");
  private selected: AbilityKey = "Q";
  private signature = "";
  private readonly gs: GameScene;
  private readonly options: AbilityGuideOptions;

  constructor(gs: GameScene, options: AbilityGuideOptions) {
    this.gs = gs;
    this.options = options;
    this.style.textContent = CSS;
    this.toggle.setAttribute("aria-expanded", "false");
    this.toggle.setAttribute("aria-controls", "moba-ability-panel");
    this.panel.id = "moba-ability-panel";
    this.panel.hidden = true;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-label", "Champion ability guide");
    this.close.setAttribute("aria-label", "Close ability guide");
    const heading = el("div", "guide-heading");
    heading.append(this.title, this.experience);
    const header = el("header");
    header.append(heading, this.close);
    const nav = el("nav");
    nav.setAttribute("aria-label", "Inspect an ability");
    for (const tab of this.tabs) {
      nav.append(tab.button);
    }
    this.copy.tabIndex = 0;
    this.copy.setAttribute("aria-label", "Ability details");
    this.copy.append(this.name, this.rank, this.description, this.costs, this.unlock);
    this.more.setAttribute("aria-hidden", "true");
    this.panel.append(header, nav, this.copy, this.more);
    this.root.append(this.toggle, this.panel);

    this.copy.addEventListener("scroll", () => this.refreshOverflow());
    for (const event of ["pointerdown", "pointerup", "pointermove", "click"]) {
      this.root.addEventListener(event, (e) => e.stopPropagation());
    }
    this.root.addEventListener("keydown", this.fenceKey);
    this.root.addEventListener("keyup", this.fenceKey);
    this.toggle.addEventListener("click", () => {
      if (gs.matchResult || gs.controlsPaused || options.blocked()) {
        return;
      }
      if (this.open) {
        this.closeGuide();
      } else {
        this.panel.hidden = false;
        this.root.dataset.open = "true";
        this.toggle.setAttribute("aria-expanded", "true");
        options.onOpen();
        this.refresh();
        this.close.focus();
      }
    });
    this.close.addEventListener("click", () => this.closeGuide());
    for (const tab of this.tabs) {
      tab.button.addEventListener("click", () => {
        this.selected = tab.key;
        this.refresh();
      });
    }
    document.head.append(this.style);
    document.body.append(this.root);
  }

  get open(): boolean {
    return !this.panel.hidden;
  }

  private closingEscape = false;
  /** Keys inside the dialog belong to it: Tab cycles focus, Escape closes
   *  (and its keyup is swallowed so the pause overlay never sees a stray
   *  Escape release), Q/W/E/R inspect. Only M (mute) passes through. */
  private readonly fenceKey = (event: KeyboardEvent): void => {
    if (this.open) {
      if (event.key !== "m" && event.key !== "M") {
        event.stopPropagation();
      }
      if (event.key === "Tab" && event.type === "keydown") {
        event.preventDefault();
        const focusable: HTMLElement[] = [
          this.close,
          ...this.tabs.map((tab) => tab.button),
          this.copy,
        ];
        const { activeElement } = document;
        const current =
          activeElement instanceof HTMLElement ? focusable.indexOf(activeElement) : -1;
        focusable[
          (current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length
        ]?.focus();
        return;
      }
      if (event.key === "Escape") {
        if (event.type === "keydown") {
          event.preventDefault();
          this.closingEscape = true;
          this.closeGuide();
        }
        return;
      }
      const key = KEYS.find((k) => k === event.key.toUpperCase());
      if (key && event.type === "keydown") {
        this.selected = key;
        this.refresh();
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.stopPropagation();
    } else if (event.key === "Escape" && event.type === "keyup" && this.closingEscape) {
      event.stopPropagation();
      this.closingEscape = false;
    }
  };

  closeGuide(focus = true): void {
    if (!this.open) {
      return;
    }
    this.panel.hidden = true;
    this.root.dataset.open = "false";
    this.toggle.setAttribute("aria-expanded", "false");
    this.options.onClose();
    if (focus) {
      this.toggle.focus();
    }
  }

  /** Hide the whole surface (result screen), not just the dialog. */
  hide(): void {
    this.closeGuide(false);
    this.root.hidden = true;
  }

  refresh(): void {
    const me = this.gs.player;
    const hero = me?.hero;
    this.root.hidden = !hero || !!this.gs.matchResult || this.options.blocked();
    if (!me || !hero || !this.open) {
      return;
    }
    const signature = `${hero.defId}:${hero.level}:${Math.floor(hero.xp)}:${hero.abilityPoints}:${
      me.alive
    }:${this.selected}:${KEYS.map((key) => hero.abilities[key].rank).join(",")}`;
    if (signature === this.signature) {
      this.refreshOverflow();
      return;
    }
    this.signature = signature;
    const explanation = abilityExplanation(hero, this.selected);
    if (!explanation) {
      return;
    }
    this.title.textContent = HERO_BY_ID[hero.defId]?.name ?? "Your champion";
    this.experience.textContent = `Level ${hero.level} · ${experienceProgress(hero).text}`;
    this.name.textContent = explanation.name;
    this.rank.textContent = explanation.rank;
    this.description.textContent = explanation.description;
    this.costs.textContent = explanation.costs;
    this.unlock.textContent = me.alive ? explanation.unlock : "Upgrade after respawning";
    for (const tab of this.tabs) {
      tab.button.setAttribute("aria-pressed", String(tab.key === this.selected));
      tab.button.setAttribute(
        "aria-label",
        `Inspect ${tab.key}: ${HERO_BY_ID[hero.defId]?.abilities[tab.key].name ?? tab.key}`,
      );
    }
    this.refreshOverflow();
  }

  private refreshOverflow(): void {
    const more =
      this.open && this.copy.scrollHeight - this.copy.clientHeight - this.copy.scrollTop > 2;
    const visibility = more ? "visible" : "hidden";
    if (this.more.style.visibility !== visibility) {
      this.more.style.visibility = visibility;
    }
  }

  place(at: GuidePlacement): void {
    this.toggle.style.width = `${at.toggleWidth}px`;
    this.toggle.style.left = `${at.x}px`;
    this.toggle.style.top = `${at.y}px`;
    this.panel.style.left = `${at.x}px`;
    this.panel.style.top = `${at.y + 52}px`;
    this.panel.style.width = `${at.panelWidth}px`;
    this.panel.style.maxHeight = `${at.maxHeight}px`;
  }

  /** DOM, not a Phaser object: the owning scene must remove it on shutdown. */
  destroy(): void {
    this.root.remove();
    this.style.remove();
  }
}

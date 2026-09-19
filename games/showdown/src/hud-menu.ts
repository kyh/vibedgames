// The brawler picker on the title screen: one card per kit with a swatch,
// role line and three comparative stat bars.

import { BRAWLERS } from "./config";
import type { AttackDef, BrawlerDef, BrawlerId } from "./config";

const CARD_EMOJI: Record<BrawlerId, string> = {
  ace: "🎯",
  dusty: "💥",
  fuse: "💣",
  titan: "🥊",
};

/** Relative damage bar per attack kind; kinds not listed read as 0.8. */
const DAMAGE_BAR: Partial<Record<AttackDef["kind"], number>> = {
  burst: 0.75,
  lob: 0.7,
  spread: 0.85,
};

/** The heaviest brawler's health fills the bar. */
const MAX_HP = 6200;
/** The longest attack range fills the bar. */
const MAX_RANGE = 9.5;

const hex = (color: number): string => `#${color.toString(16).padStart(6, "0")}`;

const statBar = (label: string, fill: number): string =>
  `<div class="stat"><span>${label}</span><i><b style="width:${Math.round(fill * 100)}%"></b></i></div>`;

const cardMarkup = (def: BrawlerDef): string => {
  const swatch = `linear-gradient(135deg, ${hex(def.palette.body)}, ${hex(def.palette.accent)})`;
  const damage = DAMAGE_BAR[def.attack.kind] ?? 0.8;
  return `<div class="swatch" style="background:${swatch}">${CARD_EMOJI[def.id]}</div>
        <h2>${def.name}</h2><div class="role">${def.role}</div><p>${def.blurb}</p>
        ${statBar("HEALTH", def.hp / MAX_HP)}${statBar("RANGE", def.attack.range / MAX_RANGE)}${statBar("DAMAGE", damage)}`;
};

/** Build one card per brawler into `container`; `onPick` fires on click, Enter or Space. */
export const buildBrawlerCards = (
  container: HTMLElement,
  selected: BrawlerId,
  onPick: (id: BrawlerId) => void,
): void => {
  for (const def of Object.values(BRAWLERS)) {
    const card = document.createElement("div");
    const on = def.id === selected;
    card.className = `card${on ? " on" : ""}`;
    card.dataset.id = def.id;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", String(on));
    card.innerHTML = cardMarkup(def);
    const pick = (): void => onPick(def.id);
    card.addEventListener("click", pick);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        pick();
      }
    });
    container.append(card);
  }
};

/** Highlight the chosen card and demote the rest. */
export const markSelectedCard = (selected: BrawlerId): void => {
  for (const card of document.querySelectorAll<HTMLElement>("#cards .card")) {
    const on = card.dataset.id === selected;
    card.classList.toggle("on", on);
    card.setAttribute("aria-pressed", String(on));
  }
};

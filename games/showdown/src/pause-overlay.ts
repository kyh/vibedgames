// The wrapper pause surface: the stock @repo/embed overlay (controls filtered
// per device / connected pad, a "how to play" modal, the sound toggle) under a
// thin banner in the game's own face that says whether the arena froze. Solo
// play freezes; an online arena keeps running while the player is here, and
// the copy must say so before they wander off for a coffee.

import { createPauseOverlay, PAUSE_OVERLAY_Z } from "@repo/embed";
import type { HelpSection, MuteAccessor, PauseOverlay } from "@repo/embed";

import { BRAWLERS, TUNING } from "./config";
import type { AttackDef, BrawlerDef } from "./config";
import { CONTROLS } from "./controls";
import { EVADE } from "./entities/evasion";

export interface ShowdownPauseOverlayOptions {
  /** True while the arena keeps simulating behind the overlay (online play). */
  isLive: () => boolean;
  mute: MuteAccessor;
}

const BANNER_ID = "showdown-pause-banner";

/** Game tokens (src/style.css): display face, gold, ink. */
const FONT = "'Fredoka', 'Arial Rounded MT Bold', 'Segoe UI', system-ui, sans-serif";
const GOLD = "#e8c778";
const INK = "#193a32";

const describeAttack = (attack: AttackDef): string => {
  switch (attack.kind) {
    case "spread": {
      return `a ${attack.pellets}-bolt volley`;
    }
    case "burst": {
      return `a ${attack.count}-arrow volley`;
    }
    case "melee": {
      return `a close-range weapon sweep`;
    }
    case "lob": {
      return "a fire spell that arcs over walls";
    }
    case "leap": {
      return "a mighty leap with a ground-shaking landing";
    }
    default: {
      return "an attack";
    }
  }
};

const describeBrawler = (def: BrawlerDef): string =>
  `${def.name} (${def.role}, ${def.hp} HP): ${def.blurb} Attack is ${describeAttack(def.attack)}; ` +
  `the super is ${describeAttack(def.super)}${def.super.breaksWalls ? " and breaks walls" : ""}.`;

/** Long-form mechanics behind the overlay's "how to play" button. */
const HELP: readonly HelpSection[] = [
  {
    body: `${TUNING.bots + 1} champions enter the woodland tournament; be the last one standing. ${TUNING.bots} bots hunt with the same kits you can pick.`,
    title: "The showdown",
  },
  {
    body: Object.values(BRAWLERS).map(describeBrawler).join(" "),
    title: "Champions",
  },
  {
    body:
      "Press Shift, B / LB on a controller, or the dodge button to evade in your movement direction. " +
      "Stand still to evade toward your aim. The opening of the roll, dash or blink avoids weapon hits. " +
      `Evading interrupts attacks, recharges in ${EVADE.cooldown} seconds, and cannot cross walls or escape gas damage.`,
    title: "Evasion",
  },
  {
    body:
      "Dealing damage charges your super. Hold the super input to see its reach, release to fire it. " +
      "Each champion's super has its own reach and impact.",
    title: "Supers",
  },
  {
    body:
      "Crates hold power cubes; so do fallen champions. Each cube adds health and damage, " +
      "and each kill drops a share of the victim's cubes.",
    title: "Power cubes",
  },
  {
    body:
      "Bushes hide you until you attack or get hit. Water slows everyone down. " +
      "Walls stop shots but not lobs, leaps or supers.",
    title: "Cover",
  },
  {
    body:
      `After ${TUNING.gasDelay} seconds the poison gas closes in from the edges and keeps ` +
      "shrinking the safe zone. Stay inside the ring or bleed out.",
    title: "The gas",
  },
  {
    body:
      "The match runs from late afternoon into night. As the light fails, lanterns and your " +
      "own glow are what you see by, and charged supers pulse gold in the dark. T locks or frees the clock.",
    title: "Time of day",
  },
];

/** A strip above the stock overlay: paused, or a warning that play goes on. */
const showBanner = (live: boolean): void => {
  document.querySelector(`#${BANNER_ID}`)?.remove();
  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.setAttribute("role", "status");
  banner.textContent = live
    ? "ONLINE · THE ARENA KEEPS RUNNING WHILE YOU ARE HERE"
    : "SOLO · THE ARENA IS FROZEN";
  banner.style.cssText =
    `position:fixed;top:calc(18px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);` +
    `z-index:${PAUSE_OVERLAY_Z + 1};pointer-events:none;padding:6px 16px;border-radius:999px;` +
    `background:${live ? GOLD : "#193f36ed"};color:${live ? INK : GOLD};` +
    `border:2px solid ${GOLD};font:16px/1.3 ${FONT};letter-spacing:0.08em;text-align:center;` +
    "max-width:min(92vw,520px);white-space:normal";
  document.body.append(banner);
};

const hideBanner = (): void => {
  document.querySelector(`#${BANNER_ID}`)?.remove();
};

/** show(): mount the overlay and banner; hide(): remove both. Both idempotent. */
export const createShowdownPauseOverlay = (options: ShowdownPauseOverlayOptions): PauseOverlay => {
  const overlay = createPauseOverlay({ controls: CONTROLS, help: HELP, mute: options.mute });
  return {
    hide: () => {
      hideBanner();
      overlay.hide();
    },
    show: () => {
      overlay.show();
      showBanner(options.isLive());
    },
  };
};

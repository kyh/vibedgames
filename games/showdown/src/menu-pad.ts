// Pad navigation for the DOM screens: the d-pad or left stick walks the
// brawler cards, A / START presses the screen's primary button. Menus are
// where a controller player would otherwise reach for the mouse.

import { BRAWLERS, isBrawlerId } from "./config";
import type { BrawlerId } from "./config";
import { mustGet } from "./dom";
import type { Input } from "./input";

/** Stick must return inside this before it can step the selection again. */
const STICK_RELEASE = 0.4;

interface MenuPadHost {
  readonly input: Input;
  readonly hud: { selected: BrawlerId; select: (id: BrawlerId) => void };
}

const isOpen = (id: string): boolean => mustGet(id).classList.contains("open");

export class MenuPad {
  private readonly host: MenuPadHost;
  private stickArmed = true;

  constructor(host: MenuPadHost) {
    this.host = host;
  }

  /** Once per frame, after `input.poll()`. */
  update(): void {
    const { input } = this.host;
    if (isOpen("menu")) {
      this.stepCards(this.navigationEdge(input));
      if (input.padJustPressed("a") || input.padJustPressed("start")) {
        mustGet("play").click();
      }
      return;
    }
    if (isOpen("result") && (input.padJustPressed("a") || input.padJustPressed("start"))) {
      const again = mustGet("again");
      if (!again.hidden) {
        again.click();
      }
    }
  }

  /** The roster is a three-column grid; a stick must recenter between selections. */
  private navigationEdge(input: Input): number {
    if (input.padJustPressed("left")) {
      return -1;
    }
    if (input.padJustPressed("right")) {
      return 1;
    }
    if (input.padJustPressed("up")) {
      return -3;
    }
    if (input.padJustPressed("down")) {
      return 3;
    }
    const stick = input.padStick();
    if (stick === null || Math.max(Math.abs(stick.x), Math.abs(stick.z)) < STICK_RELEASE) {
      this.stickArmed = true;
      return 0;
    }
    if (!this.stickArmed) {
      return 0;
    }
    this.stickArmed = false;
    return Math.abs(stick.x) >= Math.abs(stick.z) ? Math.sign(stick.x) : Math.sign(stick.z) * 3;
  }

  private stepCards(step: number): void {
    if (step === 0) {
      return;
    }
    const ids = Object.keys(BRAWLERS).filter(isBrawlerId);
    const index = ids.indexOf(this.host.hud.selected);
    const next = ids[(index + step + ids.length) % ids.length];
    if (next) {
      this.host.hud.select(next);
      document
        .querySelector<HTMLElement>(`#cards [data-id="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }
}

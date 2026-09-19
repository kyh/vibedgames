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
      this.stepCards(this.horizontalEdge(input));
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

  /** -1 / +1 on a fresh d-pad press or stick push, 0 otherwise. */
  private horizontalEdge(input: Input): number {
    if (input.padJustPressed("left")) {
      return -1;
    }
    if (input.padJustPressed("right")) {
      return 1;
    }
    const stick = input.padStick();
    if (stick === null || Math.abs(stick.x) < STICK_RELEASE) {
      this.stickArmed = true;
      return 0;
    }
    if (!this.stickArmed) {
      return 0;
    }
    this.stickArmed = false;
    return Math.sign(stick.x);
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
    }
  }
}

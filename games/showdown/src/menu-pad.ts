import { BRAWLERS, isBrawlerId } from "./config";
import type { BrawlerId } from "./config";
import { mustGet } from "./dom";
import type { Input } from "./input";

const STICK_RELEASE = 0.4;

interface MenuPadHost {
  readonly input: Input;
  readonly hud: { selected: BrawlerId; select: (id: BrawlerId) => void };
}

const isOpen = (screen: HTMLElement) => screen.classList.contains("open");

export class MenuPad {
  private readonly host: MenuPadHost;
  private readonly menu = mustGet("menu");
  private readonly result = mustGet("result");
  private readonly play = mustGet("play");
  private readonly again = mustGet("again");
  private stickArmed = true;

  constructor(host: MenuPadHost) {
    this.host = host;
  }

  /** Once per frame, after `input.poll()`. */
  update() {
    const { input } = this.host;

    if (isOpen(this.menu)) {
      this.stepCards(this.navigationEdge(input));

      if (input.padJustPressed("a") || input.padJustPressed("start")) {
        this.play.click();
      }

      return;
    }

    if (
      isOpen(this.result) &&
      this.again.hidden === false &&
      (input.padJustPressed("a") || input.padJustPressed("start"))
    ) {
      this.again.click();
    }
  }

  private navigationEdge(input: Input) {
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

  private stepCards(step: number) {
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

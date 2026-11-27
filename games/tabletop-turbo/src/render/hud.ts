import { isPadConnected } from "@vibedgames/gamepad/dom";

import type { ItemKind } from "../shared/constants";

export interface HudRow {
  key: string;
  name: string;
  css: string;
  score: number;
  me: boolean;
  /** Off the board right now. */
  out: boolean;
}

export interface HudCallbacks {
  onStart: () => void;
}

export type BannerTone = "good" | "bad" | "warn" | "plain";

const ITEM_NAMES = {
  giant: "GIANT",
  mega: "MEGA BUMPER",
  spring: "LONG SPRING",
  turbo: "TURBO",
} as const satisfies Record<ItemKind, string>;

export const itemName = (kind: ItemKind) => ITEM_NAMES[kind];

const ORDINALS = ["1ST", "2ND", "3RD", "4TH", "5TH", "6TH", "7TH", "8TH"] as const;

const el = (id: string) => {
  const node = document.querySelector<HTMLElement>(`#${id}`);

  if (!node) {
    throw new Error(`missing #${id}`);
  }

  return node;
};

const clockText = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const rowNode = (row: HudRow, rank: number | null) => {
  const node = document.createElement("div");
  node.dataset.me = row.me ? "1" : "0";
  node.dataset.out = row.out ? "1" : "0";

  if (rank !== null) {
    const place = document.createElement("em");
    place.textContent = String(rank);
    node.append(place);
  }

  const swatch = document.createElement("i");
  swatch.style.background = row.css;
  const name = document.createElement("span");
  name.textContent = row.name;
  const score = document.createElement("b");
  score.textContent = String(row.score);
  node.append(swatch, name, score);

  return node;
};

/** The page around the canvas: everything here is DOM, laid over the art. */
export class Hud {
  private readonly hud = el("hud");
  private readonly title = el("title");
  private readonly results = el("results");
  private readonly score = el("score");
  private readonly place = el("place");
  private readonly time = el("time");
  private readonly round = el("round");
  private readonly clock = el("clock");
  private readonly board = el("board");
  private readonly feedBox = el("feed");
  private readonly bannerBox = el("banner");
  private readonly countBox = el("count");
  private readonly punch = el("punch");
  private readonly boost = el("boost");
  private readonly item = el("item");
  private readonly itemName = el("item-name");
  private readonly net = el("net");
  private readonly pops = el("pops");
  private readonly controls = el("controls");
  private readonly punchBar: HTMLElement | null;
  private readonly boostBar: HTMLElement | null;
  private boardKey = "";
  private lastScore = -1;
  private lastCount = "";
  private bannerUntil = 0;
  private clockKey = "";
  private padSeen = false;

  constructor(callbacks: HudCallbacks) {
    this.punchBar = this.punch.querySelector("i");
    this.boostBar = this.boost.querySelector("i");
    el("start").addEventListener("click", () => {
      callbacks.onStart();
    });
    this.writeControls();
  }

  showTitle(on: boolean) {
    this.title.dataset.on = on ? "1" : "0";
  }

  showHud(on: boolean) {
    this.hud.dataset.on = on ? "1" : "0";
  }

  /** The player's colour, as the HUD wears it. */
  setTint(css: string) {
    this.hud.ownerDocument.documentElement.style.setProperty("--me", css);
  }

  setClock(msLeft: number, round: number, urgent: boolean) {
    const text = clockText(msLeft);
    const key = `${text}:${round}:${urgent ? 1 : 0}`;

    if (key !== this.clockKey) {
      this.clockKey = key;
      this.time.textContent = text;
      this.round.textContent = `Round ${round}`;
      this.clock.dataset.urgent = urgent ? "1" : "0";
    }
  }

  setScore(score: number, place: number) {
    if (score !== this.lastScore) {
      this.score.textContent = String(score);
      this.score.dataset.bump = "0";

      if (score > this.lastScore && this.lastScore >= 0) {
        requestAnimationFrame(() => {
          this.score.dataset.bump = "1";
        });
      }

      this.lastScore = score;
    }

    this.place.textContent = ORDINALS[place - 1] ?? "";
  }

  /** The scoreboard, best first. Rebuilt only when something on it changed. */
  setBoard(rows: readonly HudRow[]) {
    const key = rows
      .map((row) => `${row.key}:${row.score}:${row.out ? 1 : 0}:${row.name}`)
      .join("|");

    if (key !== this.boardKey) {
      this.boardKey = key;
      this.board.replaceChildren(...rows.map((row) => rowNode(row, null)));
    }
  }

  /** One line of the knock-off feed: who, and whom. `by` null is a car that fell on its own. */
  feed(by: HudRow | null, victim: HudRow) {
    const line = document.createElement("div");

    const add = (row: HudRow) => {
      const swatch = document.createElement("i");
      swatch.style.background = row.css;
      line.append(swatch, row.name);
    };

    if (by) {
      add(by);
      const verb = document.createElement("em");
      verb.textContent = "knocked off";
      line.append(verb);
      add(victim);
    } else {
      add(victim);
      const verb = document.createElement("em");
      verb.textContent = "fell off";
      line.append(verb);
    }

    this.feedBox.append(line);
    line.addEventListener("animationend", () => {
      line.remove();
    });

    while (this.feedBox.children.length > 4) {
      this.feedBox.firstElementChild?.remove();
    }
  }

  /** `punch` and `boost` 0–1; `item` is what the car is wearing. */
  setDash(punch: number, boost: number, canBoost: boolean, item: ItemKind | "") {
    if (this.punchBar) {
      this.punchBar.style.width = `${Math.round(punch * 100)}%`;
    }

    this.punch.dataset.ready = punch >= 1 ? "1" : "0";

    if (this.boostBar) {
      this.boostBar.style.width = `${Math.round(boost * 100)}%`;
    }

    this.boost.dataset.low = canBoost ? "0" : "1";

    if (this.item.dataset.kind !== item) {
      this.item.dataset.kind = item;
      this.itemName.textContent = item === "" ? "" : ITEM_NAMES[item];
    }
  }

  banner(text: string, tone: BannerTone, ms = 1600) {
    this.bannerBox.textContent = text;
    this.bannerBox.dataset.tone = tone;
    this.bannerBox.dataset.on = "0";
    this.bannerUntil = performance.now() + ms;
    requestAnimationFrame(() => {
      this.bannerBox.dataset.on = "1";
    });
  }

  /** Call every frame: takes the banner down when its time is up. */
  tick() {
    if (this.bannerUntil > 0 && performance.now() > this.bannerUntil) {
      this.bannerUntil = 0;
      this.bannerBox.dataset.on = "0";
    }

    if (!this.padSeen && isPadConnected()) {
      this.padSeen = true;
      this.writeControls();
    }
  }

  /** The start count: "3", "2", "1", "GO", or "" for nothing. */
  count(text: string) {
    if (text !== this.lastCount) {
      this.lastCount = text;
      this.countBox.dataset.go = text === "GO" ? "1" : "0";
      const digit = document.createElement("b");
      digit.textContent = text;
      this.countBox.replaceChildren(digit);
    }
  }

  /** Words that rise off a point on the page and fade. */
  pop(text: string, x: number, y: number, css: string) {
    const node = document.createElement("span");
    node.textContent = text;
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
    node.style.color = css;
    this.pops.append(node);
    node.addEventListener("animationend", () => {
      node.remove();
    });
  }

  setNet(text: string) {
    if (this.net.textContent !== text) {
      this.net.textContent = text;
    }
  }

  showResults(on: boolean, rows: readonly HudRow[] = [], won = false, next = "") {
    if (!on) {
      this.results.dataset.on = "0";

      return;
    }

    if (this.results.dataset.on !== "1") {
      this.results.dataset.on = "1";
      const heading = el("results-title");
      heading.textContent = won ? "YOU WIN" : "ROUND OVER";
      heading.dataset.won = won ? "1" : "0";
      el("results-rows").replaceChildren(...rows.map((row, i) => rowNode(row, i + 1)));
    }

    el("results-next").textContent = next;
  }

  private writeControls() {
    const touch = document.body.classList.contains("touch");

    const rows: (readonly [string, string])[] = touch
      ? [
          ["DRAG", "drive"],
          ["PUNCH", "fire the bumper"],
          ["BOOST", "hold"],
        ]
      : [
          ["WASD / ARROWS", "drive"],
          ["SPACE", "fire the bumper"],
          ["SHIFT", "boost"],
        ];

    if (this.padSeen) {
      rows.push(["PAD", "stick, A to punch, B to boost"]);
    }

    this.controls.replaceChildren(
      ...rows.flatMap(([key, what], i) => {
        const strong = document.createElement("b");
        strong.textContent = key;
        const gap = i < rows.length - 1 ? "   ·   " : "";

        return [strong, ` ${what}${gap}`];
      }),
    );
  }
}

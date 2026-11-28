import { isPadConnected } from "@vibedgames/gamepad/dom";

import { BASE, CAR_RAMPS, rampCss } from "../pixel/palette";
import { CAR_KINDS, KINDS, kindPips } from "../sim/kinds";
import type { CarKind } from "../sim/kinds";
import type { SpecialKind } from "../sim/specials";
import { SPECIAL_RAMP } from "./props";
import { Radar } from "./radar";

export interface HudRow {
  key: string;
  name: string;
  css: string;
  score: number;
  me: boolean;
  /** Off the board right now. */
  out: boolean;
}

/** A label that rides over a car: its damage, and its name if it is somebody else. */
export interface HudTag {
  x: number;
  y: number;
  name: string;
  damage: number;
}

export interface HudCallbacks {
  onStart: () => void;
  /** The picker moved: the car type and which of the car colours. */
  onPick: (kind: CarKind, colour: number) => void;
  /** Back to the title to choose another car. */
  onGarage: () => void;
}

export type BannerTone = "good" | "bad" | "warn" | "plain";

const SPECIAL_NAMES = {
  giant: "GIANT",
  magnet: "MAGNET",
  mine: "MINE",
  oil: "OIL SLICK",
  rocket: "ROCKET",
  seeker: "SEEKER",
  shield: "SHIELD",
  shock: "SHOCKWAVE",
  spring: "SPRING",
  turbo: "TURBO",
  wrench: "WRENCH",
  zap: "ZAP",
} as const satisfies Record<SpecialKind, string>;

export const specialName = (kind: SpecialKind) => SPECIAL_NAMES[kind];

const ICONS = {
  giant: [
    "...##...",
    "..####..",
    ".######.",
    "########",
    "..####..",
    "..####..",
    "..####..",
    "..####..",
  ],
  magnet: [
    "##....##",
    "##....##",
    "##....##",
    "##....##",
    "##....##",
    "###..###",
    ".######.",
    "..####..",
  ],
  mine: [
    "#..##..#",
    ".######.",
    ".##..##.",
    "##.##.##",
    "##.##.##",
    ".##..##.",
    ".######.",
    "#..##..#",
  ],
  oil: [
    "...#....",
    "...##...",
    "..###...",
    ".#####..",
    ".######.",
    ".######.",
    ".######.",
    "..####..",
  ],
  rocket: [
    ".....###",
    "....####",
    "...####.",
    "#.####..",
    ".####...",
    ".###....",
    "#.#.#...",
    "...#....",
  ],
  seeker: [
    "...##...",
    ".#.##.#.",
    "..#..#..",
    "##.##.##",
    "##.##.##",
    "..#..#..",
    ".#.##.#.",
    "...##...",
  ],
  shield: [
    "########",
    "########",
    "########",
    "########",
    ".######.",
    ".######.",
    "..####..",
    "...##...",
  ],
  shock: [
    "..####..",
    ".#....#.",
    "#..##..#",
    "#.#..#.#",
    "#.#..#.#",
    "#..##..#",
    ".#....#.",
    "..####..",
  ],
  spring: [
    ".######.",
    "......#.",
    ".######.",
    ".#......",
    ".######.",
    "......#.",
    ".######.",
    "########",
  ],
  turbo: [
    "#...#...",
    "##..##..",
    ".##..##.",
    "..##..##",
    "..##..##",
    ".##..##.",
    "##..##..",
    "#...#...",
  ],
  wrench: [
    "..####..",
    "..####..",
    "########",
    "########",
    "########",
    "########",
    "..####..",
    "..####..",
  ],
  zap: [
    "....###.",
    "...###..",
    "..###...",
    ".######.",
    "...###..",
    "..###...",
    ".###....",
    ".#......",
  ],
} as const satisfies Record<SpecialKind, readonly string[]>;

const ORDINALS = ["1ST", "2ND", "3RD", "4TH", "5TH", "6TH", "7TH", "8TH"] as const;
const PIPS = 5;
const TAGS = 8;

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

/** The colour a damage figure is written in: it heats up as the car gets easier to throw. */
export const damageCss = (damage: number) => {
  if (damage < 40) {
    return "#fff0c8";
  }

  if (damage < 90) {
    return "#f4b93a";
  }

  return damage < 150 ? "#ff8a3a" : "#ff5040";
};

const iconUrl = (rows: readonly string[], css: string) => {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return "";
  }

  ctx.fillStyle = css;

  for (const [y, row] of rows.entries()) {
    for (let x = 0; x < row.length; x += 1) {
      if (row.charAt(x) === "#") {
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  return `url(${canvas.toDataURL()})`;
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

const pipRow = (label: string) => {
  const row = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  row.append(name);
  const pips: HTMLElement[] = [];

  for (let i = 0; i < PIPS; i += 1) {
    const pip = document.createElement("i");
    pips.push(pip);
    row.append(pip);
  }

  return { pips, row };
};

/** The page around the canvas: everything here is DOM, laid over the art. */
export class Hud {
  readonly radar: Radar;
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
  private readonly attack = el("attack");
  private readonly attackLabel = el("attack-name");
  private readonly boost = el("boost");
  private readonly item = el("item");
  private readonly itemName = el("item-name");
  private readonly itemIcon = el("item-icon");
  private readonly hurt = el("hurt");
  private readonly net = el("net");
  private readonly pops = el("pops");
  private readonly controls = el("controls");
  private readonly showcase = el("showcase");
  private readonly kindName = el("kind-name");
  private readonly kindAttack = el("kind-attack");
  private readonly kindBlurb = el("kind-blurb");
  private readonly swatches: HTMLElement[] = [];
  private readonly stats: Record<"speed" | "power" | "endurance" | "reach", HTMLElement[]>;
  private readonly tags: HTMLElement[] = [];
  private readonly icons = new Map<SpecialKind, string>();
  private readonly attackBar: HTMLElement | null;
  private readonly boostBar: HTMLElement | null;
  private readonly callbacks: HudCallbacks;
  private kind: CarKind = "bumper";
  private colour = 0;
  private boardKey = "";
  private lastScore = -1;
  private lastCount = "";
  private lastHurt = -1;
  private bannerUntil = 0;
  private clockKey = "";
  private padSeen = false;

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.attackBar = this.attack.querySelector("i");
    this.boostBar = this.boost.querySelector("i");
    const canvas = document.querySelector<HTMLCanvasElement>("#radar");

    if (!canvas) {
      throw new Error("missing #radar");
    }

    this.radar = new Radar(canvas);
    el("start").addEventListener("click", () => {
      callbacks.onStart();
    });
    el("garage").addEventListener("click", () => {
      callbacks.onGarage();
    });
    el("kind-prev").addEventListener("click", () => {
      this.nudgePick(-1, 0);
    });
    el("kind-next").addEventListener("click", () => {
      this.nudgePick(1, 0);
    });
    const speed = pipRow("SPEED");
    const power = pipRow("POWER");
    const endurance = pipRow("TOUGH");
    const reach = pipRow("REACH");
    el("kind-stats").append(speed.row, power.row, endurance.row, reach.row);

    this.stats = {
      endurance: endurance.pips,
      power: power.pips,
      reach: reach.pips,
      speed: speed.pips,
    };
    const row = el("swatches");

    for (const [index, ramp] of CAR_RAMPS.entries()) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.style.background = rampCss(ramp, BASE + 1);
      swatch.setAttribute("aria-label", `Colour ${index + 1}`);
      swatch.addEventListener("click", () => {
        this.setPick(this.kind, index, true);
      });
      this.swatches.push(swatch);
      row.append(swatch);
    }

    const tagBox = el("tags");

    for (let i = 0; i < TAGS; i += 1) {
      const tag = document.createElement("span");
      tag.hidden = true;
      this.tags.push(tag);
      tagBox.append(tag);
    }

    this.writeControls();
    this.setPick(this.kind, this.colour, false);
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

  /** Show `kind` in colour `colour` on the picker. `tell` passes the choice on. */
  setPick(kind: CarKind, colour: number, tell: boolean) {
    const def = KINDS[kind];
    const pips = kindPips(kind);
    this.kind = kind;
    this.colour = ((colour % CAR_RAMPS.length) + CAR_RAMPS.length) % CAR_RAMPS.length;
    this.kindName.textContent = def.name;
    this.kindAttack.textContent = def.attackName;
    this.kindBlurb.textContent = def.blurb;
    this.attackLabel.textContent = def.attackName;

    for (const [name, lit] of [
      ["speed", pips.speed],
      ["power", pips.power],
      ["endurance", pips.endurance],
      ["reach", pips.reach],
    ] as const) {
      for (const [i, pip] of this.stats[name].entries()) {
        pip.dataset.on = i < lit ? "1" : "0";
      }
    }

    for (const [i, swatch] of this.swatches.entries()) {
      swatch.dataset.on = i === this.colour ? "1" : "0";
    }

    this.setTint(rampCss(CAR_RAMPS[this.colour] ?? CAR_RAMPS[0], BASE + 1));

    if (tell) {
      this.callbacks.onPick(this.kind, this.colour);
    }
  }

  /** Step the picker: `across` through the car types, `down` through the colours. */
  nudgePick(across: number, down: number) {
    if (across === 0 && down === 0) {
      return;
    }

    const count = CAR_KINDS.length;
    const at = (CAR_KINDS.indexOf(this.kind) + across + count) % count;
    this.setPick(CAR_KINDS[at] ?? "bumper", this.colour + down, true);
  }

  /** Where on the page the title leaves room for the car, as fractions of the window. */
  showcaseAt() {
    const box = this.showcase.getBoundingClientRect();
    const wide = window.innerWidth || 1;
    const high = window.innerHeight || 1;

    return { x: (box.left + box.width / 2) / wide, y: (box.top + box.height / 2) / high };
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
      .map((row) => `${row.key}:${row.score}:${row.out ? 1 : 0}:${row.name}:${row.css}`)
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

  /** `attack` and `boost` 0–1, the special in hand and the damage on the car. */
  setDash(
    attack: number,
    boost: number,
    canBoost: boolean,
    special: SpecialKind | "",
    damage: number,
  ) {
    if (this.attackBar) {
      this.attackBar.style.width = `${Math.round(attack * 100)}%`;
    }

    this.attack.dataset.ready = attack >= 1 ? "1" : "0";

    if (this.boostBar) {
      this.boostBar.style.width = `${Math.round(boost * 100)}%`;
    }

    this.boost.dataset.low = canBoost ? "0" : "1";

    if (this.item.dataset.kind !== special) {
      this.item.dataset.kind = special;
      this.itemName.textContent = special === "" ? "EMPTY" : SPECIAL_NAMES[special];
      this.itemIcon.style.backgroundImage = special === "" ? "none" : this.iconOf(special);
    }

    const whole = Math.round(damage);

    if (whole !== this.lastHurt) {
      this.hurt.textContent = `${whole}%`;
      this.hurt.style.color = damageCss(whole);
      this.hurt.dataset.bump = "0";

      if (whole > this.lastHurt) {
        requestAnimationFrame(() => {
          this.hurt.dataset.bump = "1";
        });
      }

      this.lastHurt = whole;
    }
  }

  /** The labels over the cars this frame, in page pixels. Any left over are hidden. */
  setTags(tags: readonly HudTag[]) {
    for (const [i, node] of this.tags.entries()) {
      const tag = tags[i];

      if (tag) {
        const text = `${tag.name === "" ? "" : `${tag.name} `}${Math.round(tag.damage)}%`;

        if (node.textContent !== text) {
          node.textContent = text;
          node.style.color = damageCss(tag.damage);
        }

        node.style.transform = `translate(${Math.round(tag.x)}px, ${Math.round(tag.y)}px) translate(-50%, -100%)`;
      }

      node.hidden = !tag;
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

  private iconOf(special: SpecialKind) {
    let url = this.icons.get(special);

    if (url === undefined) {
      url = iconUrl(ICONS[special], rampCss(SPECIAL_RAMP[special], BASE + 2));
      this.icons.set(special, url);
    }

    return url;
  }

  private writeControls() {
    const touch = document.body.classList.contains("touch");

    const rows: (readonly [string, string])[] = touch
      ? [
          ["DRAG", "up to go, across to steer"],
          ["HIT", "attack"],
          ["ITEM", "use your special"],
          ["BOOST", "hold"],
        ]
      : [
          ["W S", "go and back up"],
          ["A D", "steer"],
          ["SPACE", "attack"],
          ["E", "special"],
          ["SHIFT", "boost"],
        ];

    if (this.padSeen) {
      rows.push(["PAD", "stick, A attack, Y special, B boost"]);
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

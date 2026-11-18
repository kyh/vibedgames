import { BOSS, SAFE, START } from "../data/rooms";
import type { RoomType } from "../data/rooms";
import { genCombatRoom } from "./gen";
import { rand } from "./rng";

export interface Offer {
  type: RoomType;
}

const rollRoomType = () => {
  const pool: [RoomType, number][] = [
    ["combat", 50],
    ["elite", 14],
    ["merchant", 12],
    ["rest", 12],
    ["treasure", 12],
  ];

  const total = pool.reduce((s, p) => s + p[1], 0);
  let r = rand() * total;

  for (const [type, w] of pool) {
    r -= w;

    if (r <= 0) {
      return type;
    }
  }

  return "combat";
};

const twoDistinct = () => {
  const a = rollRoomType();
  let b = rollRoomType();
  let guard = 0;

  while (b === a && guard < 8) {
    guard += 1;
    b = rollRoomType();
  }

  return [{ type: a }, { type: b }];
};

export class RunManager {
  biome = 1;
  depth = 0;
  type: RoomType = "start";
  readonly bossAt = 7;

  begin() {
    this.biome = 1;
    this.depth = 1;
    this.type = "start";

    return START();
  }

  debugEnter(type: RoomType, biome = 1, depth = 2) {
    this.biome = biome;
    this.depth = depth;
    this.type = type;

    return this.templateFor(type);
  }

  isCombat(type?: RoomType) {
    const t = type ?? this.type;

    return t === "combat" || t === "elite" || t === "boss";
  }

  private templateFor(type: RoomType) {
    switch (type) {
      case "start": {
        return START();
      }

      case "combat":
      case "elite": {
        return this.nextCombat();
      }

      case "merchant":
      case "rest":
      case "treasure": {
        return SAFE();
      }

      case "boss": {
        return BOSS();
      }
    }
  }

  private nextCombat() {
    return genCombatRoom(Math.floor(rand() * 0x1_00_00_00_00), this.biome);
  }

  offers() {
    if (this.type === "boss") {
      return [{ type: "start" }] satisfies Offer[];
    }

    if (this.type === "start") {
      return [{ type: "combat" }] satisfies Offer[];
    }

    if (this.depth + 1 >= this.bossAt) {
      return [{ type: "boss" }] satisfies Offer[];
    }

    return twoDistinct() satisfies Offer[];
  }

  choose(offer: Offer) {
    if (this.type === "boss") {
      this.biome += 1;
      this.depth = 1;
      this.type = "start";

      return this.templateFor("start");
    }

    this.depth += 1;
    this.type = offer.type;

    return this.templateFor(offer.type);
  }
}

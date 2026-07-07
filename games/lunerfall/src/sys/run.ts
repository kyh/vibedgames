import { BOSS, COMBAT_TEMPLATES, type RoomDef, type RoomType, SAFE, START } from "../data/rooms";

export type Offer = { type: RoomType };

// Owns run structure: depth within a biome, which room type comes next, and the
// branching door offers. A run is start → ~5 rooms (player picks the path) →
// boss → descend to a harder biome.
export class RunManager {
  biome = 1;
  depth = 0;
  type: RoomType = "start";
  // Shuffle-bag of template indices: draw without replacement so every layout is
  // seen before any repeats, and the order is fresh each cycle — no more "always
  // template 0 first". Refilled + reshuffled when emptied.
  private bag: number[] = [];
  readonly bossAt = 7;

  begin(): RoomDef {
    this.biome = 1;
    this.depth = 1;
    this.bag = [];
    this.type = "start";
    return START();
  }

  // Dev shortcut: drop straight into a given room type (?room=combat).
  debugEnter(type: RoomType): RoomDef {
    this.biome = 1;
    this.depth = 2;
    this.bag = [];
    this.type = type;
    return this.templateFor(type);
  }

  isCombat(type: RoomType = this.type): boolean {
    return type === "combat" || type === "elite" || type === "boss";
  }

  private templateFor(type: RoomType): RoomDef {
    switch (type) {
      case "start":
        return START();
      case "combat":
      case "elite":
        return this.nextCombat();
      case "merchant":
      case "rest":
      case "treasure":
        return SAFE();
      case "boss":
        return BOSS();
    }
  }

  // Draw the next combat layout: a random unseen template, flipped left↔right
  // half the time, so consecutive fights (and the first fight of each run) vary.
  private nextCombat(): RoomDef {
    if (this.bag.length === 0) {
      this.bag = COMBAT_TEMPLATES.map((_, i) => i);
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const a = this.bag[i];
        const b = this.bag[j];
        if (a === undefined || b === undefined) continue;
        this.bag[i] = b;
        this.bag[j] = a;
      }
    }
    const idx = this.bag.pop() ?? 0;
    const make = COMBAT_TEMPLATES[idx] ?? COMBAT_TEMPLATES[0];
    const room = (make ?? START)();
    if (Math.random() < 0.5) room.mirror();
    return room;
  }

  // Door offers for the current room's exits (after clearing).
  offers(): Offer[] {
    if (this.type === "boss") return [{ type: "start" }]; // "descend" — next biome
    if (this.type === "start") return [{ type: "combat" }];
    if (this.depth + 1 >= this.bossAt) return [{ type: "boss" }];
    return this.twoDistinct();
  }

  // Advance into the room behind the chosen door; returns its template.
  choose(offer: Offer): RoomDef {
    if (this.type === "boss") {
      this.biome++;
      this.depth = 1;
      this.bag = [];
      this.type = "start";
      return this.templateFor("start");
    }
    this.depth++;
    this.type = offer.type;
    return this.templateFor(offer.type);
  }

  private roll(): RoomType {
    const pool: [RoomType, number][] = [
      ["combat", 50],
      ["elite", 14],
      ["merchant", 12],
      ["rest", 12],
      ["treasure", 12],
    ];
    const total = pool.reduce((s, p) => s + p[1], 0);
    let r = Math.random() * total;
    for (const [type, w] of pool) {
      r -= w;
      if (r <= 0) return type;
    }
    return "combat";
  }

  private twoDistinct(): Offer[] {
    const a = this.roll();
    let b = this.roll();
    let guard = 0;
    while (b === a && guard++ < 8) b = this.roll();
    return [{ type: a }, { type: b }];
  }
}

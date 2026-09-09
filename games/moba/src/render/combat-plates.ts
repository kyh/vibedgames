export interface HeroPlate {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: "player" | "target" | "hero";
}

const PRIORITY = { hero: 2, player: 0, target: 1 };

/** Resolve only visible hero labels. Keep the local hero's marker anchored;
 * move colliding labels upward, with stable identity order to avoid swaps.
 * Units, picking and simulation positions never enter this layout. */
export function layoutHeroPlates(plates: readonly HeroPlate[]) {
  const placed: (HeroPlate & { lift: number })[] = [];
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 game; only this fresh copy is mutated.
  const ordered = [...plates].sort(
    (a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.id.localeCompare(b.id),
  );
  for (const plate of ordered) {
    let { y } = plate;
    // Moving above one label may meet another. Each pass clears at least one
    // earlier label, so the visible hero count bounds the work.
    for (let pass = 0; pass < placed.length; pass++) {
      let blocked = false;
      for (const other of placed) {
        if (
          Math.abs(plate.x - other.x) < (plate.width + other.width) / 2 + 6 &&
          y < other.y + other.height + 4 &&
          y + plate.height + 4 > other.y
        ) {
          y = other.y - plate.height - 4;
          blocked = true;
        }
      }
      if (!blocked) {
        break;
      }
    }
    placed.push({ ...plate, lift: plate.y - y, y });
  }
  return placed;
}

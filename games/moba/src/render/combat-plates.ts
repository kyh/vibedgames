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
export const layoutHeroPlates = (plates: readonly HeroPlate[]) => {
  const placed: (HeroPlate & { lift: number })[] = [];

  const ordered = plates.toSorted(
    (a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.id.localeCompare(b.id),
  );

  for (const plate of ordered) {
    let { y } = plate;

    for (const _pass of placed) {
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
};

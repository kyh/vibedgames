// Shared geometry for the two hotbars (farm HUD and mine HUD). They differ in
// palette and in where they sit, but they show the same twelve inventory slots
// and must obey the same rule about how small a slot may get.

import { HOTBAR } from "../systems/inventory";

/** Smallest comfortable touch target, in CSS px. Twelve slots across a portrait
 *  phone leaves 31px — the bar wraps into rows rather than go under this. */
const MIN_TAP = 44;

export type HotbarGrid = {
  readonly slot: number;
  readonly perRow: number;
  readonly rows: number;
};

/**
 * Slot size and row split for a hotbar `avail` px wide, where a slot is at most
 * `maxSlot` and its tap zone is `slot + pad`. Rows are added — halving the
 * slots per row — until each one clears MIN_TAP, or until a single column is
 * left on a viewport too narrow for even that.
 */
export function hotbarGrid(avail: number, maxSlot: number, pad: number): HotbarGrid {
  const sizeFor = (perRow: number): number => Math.floor(avail / perRow) - pad;
  const min = Math.min(maxSlot, MIN_TAP - pad);
  let perRow = HOTBAR;
  while (perRow > 1 && sizeFor(perRow) < min) perRow = Math.ceil(perRow / 2);
  return {
    slot: Math.min(maxSlot, sizeFor(perRow)),
    perRow,
    rows: Math.ceil(HOTBAR / perRow),
  };
}

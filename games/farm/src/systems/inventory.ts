import type { Item, Slot } from "../data/items";
import { itemStackable, sameItem } from "../data/items";
import { BACKPACK } from "../config";

export const HOTBAR = 12;
export const STACK_MAX = 99;
export const TOTAL = HOTBAR + BACKPACK;

// Combined index space: 0..HOTBAR-1 = hotbar, HOTBAR..TOTAL-1 = backpack.
export class Inventory {
  slots: Slot[] = new Array(HOTBAR).fill(null);
  pack: Slot[] = new Array(BACKPACK).fill(null);
  selected = 0;

  static fresh(): Inventory {
    const inv = new Inventory();
    inv.slots[0] = { item: { kind: "tool", tool: "hoe" }, qty: 1 };
    inv.slots[1] = { item: { kind: "tool", tool: "can" }, qty: 1 };
    inv.slots[2] = { item: { kind: "tool", tool: "axe" }, qty: 1 };
    inv.slots[3] = { item: { kind: "tool", tool: "pickaxe" }, qty: 1 };
    inv.slots[4] = { item: { kind: "tool", tool: "rod" }, qty: 1 };
    inv.slots[5] = { item: { kind: "tool", tool: "sword" }, qty: 1 };
    inv.slots[6] = { item: { kind: "seed", crop: "parsnip" }, qty: 15 };
    return inv;
  }

  private at(i: number): Slot {
    return (i < HOTBAR ? this.slots[i] : this.pack[i - HOTBAR]) ?? null;
  }
  private set(i: number, s: Slot): void {
    if (i < HOTBAR) this.slots[i] = s;
    else this.pack[i - HOTBAR] = s;
  }
  slotAt(i: number): Slot {
    return this.at(i);
  }

  selectedItem(): Item | null {
    return this.slots[this.selected]?.item ?? null;
  }
  selectedSlot(): Slot {
    return this.slots[this.selected] ?? null;
  }

  select(i: number): void {
    if (i >= 0 && i < HOTBAR) this.selected = i;
  }
  cycle(dir: number): void {
    this.selected = (this.selected + dir + HOTBAR) % HOTBAR;
  }

  count(pred: (item: Item) => boolean): number {
    let n = 0;
    for (let i = 0; i < TOTAL; i++) {
      const s = this.at(i);
      if (s && pred(s.item)) n += s.qty;
    }
    return n;
  }

  // Add an item across hotbar then backpack; returns leftover (0 if all fit).
  add(item: Item, qty = 1): number {
    if (itemStackable(item)) {
      for (let i = 0; i < TOTAL; i++) {
        const s = this.at(i);
        if (s && sameItem(s.item, item) && s.qty < STACK_MAX) {
          const take = Math.min(STACK_MAX - s.qty, qty);
          s.qty += take;
          qty -= take;
          if (qty <= 0) return 0;
        }
      }
    }
    while (qty > 0) {
      let idx = -1;
      for (let i = 0; i < TOTAL; i++) {
        if (this.at(i) === null) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return qty;
      const take = itemStackable(item) ? Math.min(STACK_MAX, qty) : 1;
      this.set(idx, { item, qty: take });
      qty -= take;
    }
    return 0;
  }

  // Remove qty from the hotbar slot at idx. Empties at 0.
  consumeSlot(idx: number, qty = 1): boolean {
    const s = this.slots[idx];
    if (!s || s.qty < qty) return false;
    s.qty -= qty;
    if (s.qty <= 0) this.slots[idx] = null;
    return true;
  }

  // Remove qty of a matching item from anywhere. Returns true if fully removed.
  remove(item: Item, qty = 1): boolean {
    if (this.count((it) => sameItem(it, item)) < qty) return false;
    for (let i = 0; i < TOTAL && qty > 0; i++) {
      const s = this.at(i);
      if (s && sameItem(s.item, item)) {
        const take = Math.min(s.qty, qty);
        s.qty -= take;
        qty -= take;
        if (s.qty <= 0) this.set(i, null);
      }
    }
    return true;
  }

  // Swap/merge two combined-index slots (for the inventory UI).
  swap(a: number, b: number): void {
    if (a === b || a < 0 || b < 0 || a >= TOTAL || b >= TOTAL) return;
    const sa = this.at(a);
    const sb = this.at(b);
    // merge stacks of the same stackable item
    if (sa && sb && sameItem(sa.item, sb.item) && itemStackable(sa.item)) {
      const room = STACK_MAX - sb.qty;
      const move = Math.min(room, sa.qty);
      sb.qty += move;
      sa.qty -= move;
      if (sa.qty <= 0) this.set(a, null);
      return;
    }
    this.set(a, sb);
    this.set(b, sa);
  }

  toJSON(): { slots: Slot[]; pack: Slot[]; selected: number } {
    return { slots: this.slots, pack: this.pack, selected: this.selected };
  }

  static fromJSON(d: { slots: Slot[]; pack?: Slot[]; selected: number }): Inventory {
    const inv = new Inventory();
    inv.slots = d.slots.slice(0, HOTBAR);
    while (inv.slots.length < HOTBAR) inv.slots.push(null);
    inv.pack = (d.pack ?? []).slice(0, BACKPACK);
    while (inv.pack.length < BACKPACK) inv.pack.push(null);
    inv.selected = d.selected ?? 0;
    return inv;
  }
}

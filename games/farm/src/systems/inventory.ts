import type { Item, Slot } from "../data/items";
import { isSellable, itemStackable, sameItem, sellValue } from "../data/items";
import { BACKPACK } from "../config";

export const HOTBAR = 12;
export const STACK_MAX = 99;
export const TOTAL = HOTBAR + BACKPACK;

export interface InventoryJSON {
  slots: Slot[];
  pack: Slot[];
  selected: number;
}

export class Inventory {
  slots: Slot[] = Array.from({ length: HOTBAR }, () => null);
  pack: Slot[] = Array.from({ length: BACKPACK }, () => null);
  selected = 0;

  static fresh() {
    const inv = new Inventory();
    inv.slots[0] = { item: { kind: "tool", tool: "hoe" }, qty: 1 };
    inv.slots[1] = { item: { kind: "tool", tool: "can" }, qty: 1 };
    inv.slots[2] = { item: { kind: "tool", tool: "axe" }, qty: 1 };
    inv.slots[3] = { item: { kind: "tool", tool: "pickaxe" }, qty: 1 };
    inv.slots[4] = { item: { kind: "tool", tool: "rod" }, qty: 1 };
    inv.slots[5] = { item: { kind: "tool", tool: "sword" }, qty: 1 };
    inv.slots[6] = { item: { crop: "parsnip", kind: "seed" }, qty: 15 };

    return inv;
  }

  private at(i: number) {
    return (i < HOTBAR ? this.slots[i] : this.pack[i - HOTBAR]) ?? null;
  }
  private set(i: number, s: Slot) {
    if (i < HOTBAR) {
      this.slots[i] = s;
    } else {
      this.pack[i - HOTBAR] = s;
    }
  }
  slotAt(i: number) {
    return this.at(i);
  }

  selectedItem() {
    return this.slots[this.selected]?.item ?? null;
  }

  select(i: number) {
    if (i >= 0 && i < HOTBAR) {
      this.selected = i;
    }
  }
  cycle(dir: number) {
    this.selected = (this.selected + dir + HOTBAR) % HOTBAR;
  }

  count(pred: (item: Item) => boolean) {
    let n = 0;

    for (let i = 0; i < TOTAL; i += 1) {
      const s = this.at(i);

      if (s && pred(s.item)) {
        n += s.qty;
      }
    }

    return n;
  }

  add(item: Item, qty = 1) {
    let left = qty;

    if (itemStackable(item)) {
      for (let i = 0; i < TOTAL; i += 1) {
        const s = this.at(i);

        if (s && sameItem(s.item, item) && s.qty < STACK_MAX) {
          const take = Math.min(STACK_MAX - s.qty, left);
          s.qty += take;
          left -= take;

          if (left <= 0) {
            return 0;
          }
        }
      }
    }

    while (left > 0) {
      let idx = -1;

      for (let i = 0; i < TOTAL; i += 1) {
        if (this.at(i) === null) {
          idx = i;
          break;
        }
      }

      if (idx < 0) {
        return left;
      }

      const take = itemStackable(item) ? Math.min(STACK_MAX, left) : 1;
      this.set(idx, { item, qty: take });
      left -= take;
    }

    return 0;
  }

  consumeSlot(idx: number, qty = 1) {
    const s = this.slots[idx];

    if (!s || s.qty < qty) {
      return false;
    }

    s.qty -= qty;

    if (s.qty <= 0) {
      this.slots[idx] = null;
    }

    return true;
  }

  remove(item: Item, qty = 1) {
    if (this.count((it) => sameItem(it, item)) < qty) {
      return false;
    }

    let left = qty;

    for (let i = 0; i < TOTAL && left > 0; i += 1) {
      const s = this.at(i);

      if (s && sameItem(s.item, item)) {
        const take = Math.min(s.qty, left);
        s.qty -= take;
        left -= take;

        if (s.qty <= 0) {
          this.set(i, null);
        }
      }
    }

    return true;
  }

  sellAll() {
    let total = 0;

    for (let i = 0; i < TOTAL; i += 1) {
      const s = this.at(i);

      if (s && isSellable(s.item)) {
        total += sellValue(s.item) * s.qty;
        this.set(i, null);
      }
    }

    return total;
  }

  swap(a: number, b: number) {
    if (a === b || a < 0 || b < 0 || a >= TOTAL || b >= TOTAL) {
      return;
    }

    const sa = this.at(a);
    const sb = this.at(b);

    if (sa && sb && sameItem(sa.item, sb.item) && itemStackable(sa.item)) {
      const room = STACK_MAX - sb.qty;
      const move = Math.min(room, sa.qty);
      sb.qty += move;
      sa.qty -= move;

      if (sa.qty <= 0) {
        this.set(a, null);
      }

      return;
    }

    this.set(a, sb);
    this.set(b, sa);
  }

  toJSON() {
    return { pack: this.pack, selected: this.selected, slots: this.slots };
  }

  static fromJSON(d: { slots: Slot[]; pack?: Slot[]; selected: number }) {
    const inv = new Inventory();
    inv.slots = d.slots.slice(0, HOTBAR);

    while (inv.slots.length < HOTBAR) {
      inv.slots.push(null);
    }

    inv.pack = (d.pack ?? []).slice(0, BACKPACK);

    while (inv.pack.length < BACKPACK) {
      inv.pack.push(null);
    }

    inv.selected = d.selected ?? 0;

    return inv;
  }
}

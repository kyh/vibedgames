import { sealPointerEvents } from "@repo/embed";
import { SEASONS, seasonName, type Season } from "../data/calendar";
import type { CollectionEntry, CollectionPage } from "../systems/collections";
import "./journal.css";

export type BagPage = "inventory" | "journal";
type JournalActions = { page: (page: BagPage) => void; close: () => void };

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const button = (text: string, action: () => void) => {
  const node = element("button", "farm-bag-button", text);
  node.type = "button";
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    action();
  });
  return node;
};

/** Native navigation around the existing Phaser inventory. This view observes
 * personal discoveries; it never changes inventory, collection or clock state. */
export class JournalView {
  readonly root = element("section", "farm-bag");
  private readonly panel = element("section", "farm-journal-panel");
  private readonly heading = element("h2", "farm-journal-heading");
  private readonly progress = element("p", "farm-journal-progress");
  private readonly scroll = element("div", "farm-journal-scroll");
  private readonly seasons = new Map<Season, HTMLButtonElement>();
  private readonly inventoryButton: HTMLButtonElement;
  private readonly journalButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly priorFocus = document.activeElement;
  private readonly unseal: () => void;
  private selectedPage: BagPage = "inventory";
  private signature = "";
  private closeKey: string | null = null;
  private destroyed = false;

  constructor(
    private season: Season,
    private readonly readPage: (season: Season) => CollectionPage,
    private readonly actions: JournalActions,
  ) {
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Inventory and seasonal journal");
    const frame = element("div", "farm-bag-frame");
    const nav = element("nav", "farm-bag-nav");
    nav.setAttribute("aria-label", "Bag pages");
    this.inventoryButton = button("Inventory", () => this.selectPage("inventory"));
    this.journalButton = button("Journal", () => this.selectPage("journal"));
    this.closeButton = button("Close", actions.close);
    this.closeButton.classList.add("farm-bag-close");
    nav.append(this.inventoryButton, this.journalButton, this.closeButton);

    const head = element("header", "farm-journal-head");
    head.append(this.heading, this.progress);
    const tabs = element("nav", "farm-journal-seasons");
    tabs.setAttribute("aria-label", "Journal season");
    for (const season of SEASONS) {
      const tab = button(seasonName(season), () => {
        this.season = season;
        this.refresh();
        this.scroll.scrollTop = 0;
      });
      tab.dataset.season = season;
      this.seasons.set(season, tab);
      tabs.append(tab);
    }
    const explanation = element(
      "p",
      "farm-journal-note",
      "Harvest or catch these in their season. Finds stay recorded across years.",
    );
    this.scroll.tabIndex = 0;
    this.scroll.setAttribute("role", "region");
    this.scroll.setAttribute("aria-label", "Seasonal crop and fish checklist");
    this.panel.append(head, tabs, explanation, this.scroll);
    frame.append(nav, this.panel);
    this.root.append(frame);
    this.root.addEventListener("click", (event) => {
      if (this.page === "journal" && event.target === this.root) {
        event.stopPropagation();
        this.actions.close();
      }
    });
    this.root.addEventListener(
      "touchend",
      (event) => {
        if (this.page === "journal" && event.target === this.root) {
          event.stopPropagation();
          event.preventDefault();
          this.actions.close();
        }
      },
      { passive: false },
    );
    this.unseal = sealPointerEvents(this.root, {
      keepClick: (target) => target instanceof Element && target.closest("button") !== null,
    });
    document.body.append(this.root);
    document.body.classList.add("farm-inventory-open");
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("keyup", this.onKeyUp, true);
    this.selectPage("inventory");
    this.inventoryButton.focus({ preventScroll: true });
  }

  get page(): BagPage {
    return this.selectedPage;
  }

  setInventoryBounds(left: number, top: number, width: number): void {
    this.root.style.setProperty("--bag-left", `${left}px`);
    this.root.style.setProperty("--bag-top", `${top}px`);
    this.root.style.setProperty("--bag-width", `${width}px`);
  }

  private selectPage(page: BagPage): void {
    if (this.destroyed) return;
    this.selectedPage = page;
    this.root.dataset.page = page;
    this.panel.hidden = page !== "journal";
    this.inventoryButton.setAttribute("aria-pressed", String(page === "inventory"));
    this.journalButton.setAttribute("aria-pressed", String(page === "journal"));
    this.actions.page(page);
    this.refresh();
  }

  refresh(): void {
    if (this.destroyed || this.page !== "journal") return;
    const page = this.readPage(this.season);
    const signature = `${page.season}:${page.entries.map((entry) => Number(entry.discovered)).join("")}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.heading.textContent = `${seasonName(page.season)} findings`;
    this.progress.textContent = `${page.discovered} / ${page.total} found${page.complete ? " · Collection complete" : ""}`;
    this.progress.classList.toggle("is-complete", page.complete);
    for (const [season, tab] of this.seasons)
      tab.setAttribute("aria-pressed", String(season === page.season));
    const crops = page.entries.filter((entry) => entry.item.kind === "produce");
    const fish = page.entries.filter((entry) => entry.item.kind === "fish");
    const sections: HTMLElement[] = [];
    if (crops.length > 0) sections.push(this.entries("In the fields", crops));
    if (fish.length > 0) sections.push(this.entries("From the water", fish));
    this.scroll.classList.toggle("is-winter", crops.length === 0);
    if (crops.length === 0)
      sections.unshift(
        element("p", "farm-journal-winter", "Winter fields rest. There are still fish to find."),
      );
    this.scroll.replaceChildren(...sections);
  }

  private entries(title: string, entries: CollectionEntry[]): HTMLElement {
    const section = element("section", "farm-journal-group");
    section.append(element("h3", "", title));
    const list = element("ul", "farm-journal-list");
    for (const entry of entries) {
      const row = element("li", "farm-journal-entry");
      row.dataset.found = String(entry.discovered);
      const icon = element("img", "farm-journal-icon");
      icon.src =
        entry.item.kind === "produce"
          ? `assets/crops/${entry.item.crop}_icon.webp`
          : "assets/obj/fish.webp";
      icon.width = 32;
      icon.height = 32;
      icon.alt = "";
      row.append(
        icon,
        element("span", "farm-journal-name", entry.name),
        element("span", "farm-journal-found", entry.discovered ? "Found" : "Not yet"),
      );
      list.append(row);
    }
    section.append(list);
    return section;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    // M keeps its existing sound shortcut. Other game actions stay out of the
    // focused native controls; default Enter/Space activation is preserved.
    if (event.key.toLowerCase() === "m") return;
    event.stopPropagation();
    if (event.key === "Escape" || event.key.toLowerCase() === "i") {
      event.preventDefault();
      if (!event.repeat) this.closeKey = event.key.toLowerCase();
    } else if (event.key === "Tab") {
      const targets: HTMLElement[] = [this.inventoryButton, this.journalButton, this.closeButton];
      if (this.page === "journal") targets.push(...this.seasons.values(), this.scroll);
      const index = targets.findIndex((target) => target === document.activeElement);
      const next = event.shiftKey ? index - 1 : index + 1;
      if (index < 0 || next < 0 || next >= targets.length) {
        event.preventDefault();
        (event.shiftKey ? targets.at(-1) : targets[0])?.focus({ preventScroll: true });
      }
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (key === "escape" || key === "i") {
      // The opening I release is not a second close. Dismiss on a fresh pair
      // so neither its repeat nor release can reopen the underlying scene.
      if (this.closeKey !== key) return;
      event.stopPropagation();
      event.preventDefault();
      this.closeKey = null;
      this.actions.close();
    } else if (key === "enter" || key === " ") event.stopPropagation();
    // Movement key releases may reach Phaser to neutralize pre-open holds.
  };

  destroy(restoreFocus = true): void {
    if (this.destroyed) return;
    this.destroyed = true;
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("keyup", this.onKeyUp, true);
    this.unseal();
    this.root.remove();
    document.body.classList.remove("farm-inventory-open");
    if (restoreFocus && this.priorFocus instanceof HTMLElement && this.priorFocus.isConnected)
      this.priorFocus.focus({ preventScroll: true });
  }
}

import { controlGroups, sealPointerEvents } from "@repo/embed";
import { CONTROLS } from "../controls";
import { HERO_ORDER, HEROES } from "../data/heroes";
import { isUnlocked, UNLOCK_COST, UPGRADES, upgradeLevel } from "../data/meta";
import type { MetaState } from "../data/meta";
import type { RunRecap } from "../data/run-recap";
import "./hub.css";

export type HubState = Readonly<{
  index: number;
  meta: MetaState;
  bestScore: number;
  net: "off" | "coop" | "vs";
  code: string;
  shop: { index: number } | null;
  coarse: boolean;
}>;
export type HubActions = Readonly<{
  hero: (index: number) => void;
  go: () => void;
  forge: () => void;
  offer: (index: number) => void;
  mode: (mode: "coop" | "vs") => void;
  layout: () => void;
}>;

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const button = (text: string, action: () => void, className = "lf-hub-button") => {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
};

/** DOM owns layout and accessible targets; SelectScene owns every choice and
 * purchase. Empty hero stages reveal the original animated Phaser sprites. */
export class HubView {
  readonly root = element("section", "lf-hub");
  readonly heroes: HTMLButtonElement[] = [];
  private readonly content = element("div", "lf-hub-content");
  private readonly bank = element("div", "lf-hub-bank");
  private readonly title = element("h2", "lf-hub-hero-title");
  private readonly blurb = element("p", "lf-hub-blurb");
  private readonly controls = element("div", "lf-hub-controls");
  private readonly connection = element("p", "lf-hub-connection");
  private readonly go: HTMLButtonElement;
  private readonly coop: HTMLButtonElement;
  private readonly versus: HTMLButtonElement;
  private readonly forge: HTMLButtonElement;
  private readonly hint = element("p", "lf-hub-hint");
  private readonly dialog = element("dialog", "lf-hub-forge");
  private readonly forgeBank = element("p", "lf-hub-forge-bank");
  private readonly rows: HTMLButtonElement[] = [];
  private readonly status = element("p", "lf-hub-status");
  private readonly forgeStatus = element("p", "lf-hub-status");
  private readonly observer: ResizeObserver;
  private readonly unseal: () => void;
  private controlsSignature = "";

  constructor(actions: HubActions, recap: RunRecap | null) {
    this.root.setAttribute("aria-label", "Lunerfall warrior selection");
    this.root.tabIndex = -1;
    this.content.classList.toggle("lf-has-recap", recap !== null);
    const mast = element("header", "lf-hub-mast");
    const brand = element("div", "lf-hub-brand");
    brand.append(element("h1", "", "LUNERFALL"), element("p", "", "CHOOSE YOUR WARRIOR"));
    mast.append(brand, this.bank);
    this.content.append(mast);
    if (recap) {
      const receipt = element("section", "lf-hub-receipt");
      receipt.setAttribute("aria-label", "Last descent receipt");
      receipt.append(
        element(
          "h2",
          "",
          `${recap.kind === "coop-guest" ? "CO-OP DESCENT" : "LAST DESCENT"} · ${HEROES[recap.hero].title}`,
        ),
        element("p", "", `BIOME ${recap.biome} · DEPTH ${recap.depth} · GOLD ${recap.gold}`),
      );
      if (recap.kind === "banked")
        receipt.append(
          element(
            "p",
            "lf-hub-reward",
            `+${recap.shardsEarned} SHARDS · SCORE ${recap.score} · BEST ${recap.bestScore}`,
          ),
        );
      this.content.append(receipt);
    }
    const roster = element("section", "lf-hub-roster");
    const grid = element("div", "lf-hub-heroes");
    for (const [index, name] of HERO_ORDER.entries()) {
      const pick = button("", () => actions.hero(index), "lf-hub-hero");
      pick.dataset.hero = name;
      pick.style.setProperty("--hero", `#${HEROES[name].color.toString(16).padStart(6, "0")}`);
      pick.append(
        element("span", "lf-hub-art"),
        element("span", "lf-hub-name", HEROES[name].title),
        element("span", "lf-hub-cost"),
      );
      grid.append(pick);
      this.heroes.push(pick);
    }
    roster.append(grid, this.title, this.blurb);
    const tools = element("section", "lf-hub-tools");
    tools.append(element("h2", "lf-hub-caption", "IN THE DESCENT"), this.controls);
    this.go = button("DESCEND", actions.go, "lf-hub-button lf-hub-go");
    this.forge = button("MOON FORGE", actions.forge);
    this.coop = button("CO-OP", () => actions.mode("coop"));
    this.versus = button("VERSUS", () => actions.mode("vs"));
    const modes = element("div", "lf-hub-modes");
    modes.append(this.coop, this.versus);
    tools.append(this.go, this.forge, modes, this.connection, this.hint);
    this.status.setAttribute("role", "status");
    tools.append(this.status);
    this.content.append(roster, tools);
    this.root.append(this.content);

    const forgeHead = element("header", "lf-hub-forge-head");
    forgeHead.append(element("h2", "", "MOON FORGE"), button("CLOSE", actions.forge));
    this.dialog.setAttribute("aria-label", "Moon Forge permanent upgrades");
    this.dialog.tabIndex = -1;
    this.forgeStatus.setAttribute("role", "status");
    this.dialog.append(
      forgeHead,
      element("p", "lf-hub-forge-sub", "Permanent upgrades. Carry into every descent."),
      this.forgeBank,
    );
    for (const [index] of UPGRADES.entries()) {
      const row = button("", () => actions.offer(index), "lf-hub-upgrade");
      row.append(
        element("strong", ""),
        element("span", "lf-hub-upgrade-cost"),
        element("span", "lf-hub-upgrade-desc"),
        element("span", "lf-hub-upgrade-level"),
      );
      this.rows.push(row);
      this.dialog.append(row);
    }
    this.dialog.append(
      element(
        "p",
        "lf-hub-forge-hint",
        "Choose an upgrade. Activate it again to buy. ↑ ↓ choose · ENTER buy.",
      ),
    );
    this.dialog.append(this.forgeStatus);
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      actions.forge();
    });
    this.root.append(this.dialog);
    document.body.append(this.root);
    document.body.classList.add("lf-in-hub");
    this.unseal = sealPointerEvents(this.root, {
      keepClick: (target) => target instanceof Element && target.closest("button") !== null,
    });
    // Native focused buttons own Enter/Space. Other shortcuts keep the same
    // Phaser route; keyboard selection can start without a mandatory focus step.
    this.root.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLButtonElement && (event.key === "Enter" || event.key === " "))
        event.stopPropagation();
    });
    this.observer = new ResizeObserver(actions.layout);
    this.observer.observe(this.root);
    this.observer.observe(grid);
    this.root.addEventListener("scroll", actions.layout);
  }

  update(state: HubState): void {
    const name = HERO_ORDER[state.index];
    if (!name) return;
    const def = HEROES[name];
    const unlocked = isUnlocked(state.meta, name);
    this.bank.textContent = `✦ ${state.meta.shards} SHARDS · BEST D${state.meta.bestDepth} · ★ ${state.bestScore}`;
    this.title.textContent = def.title;
    this.title.style.color = `#${def.color.toString(16).padStart(6, "0")}`;
    this.blurb.textContent = def.blurb;
    for (const [index, node] of this.heroes.entries()) {
      const hero = HERO_ORDER[index];
      if (!hero) continue;
      const locked = !isUnlocked(state.meta, hero);
      node.setAttribute("aria-pressed", String(index === state.index));
      node.setAttribute(
        "aria-label",
        `${HEROES[hero].title}${locked ? `, locked, ${UNLOCK_COST[hero]} shards` : ""}`,
      );
      const cost = node.querySelector(".lf-hub-cost");
      if (cost)
        cost.textContent = locked
          ? `${UNLOCK_COST[hero]} ✦`
          : index === state.index
            ? "SELECTED"
            : "READY";
    }
    this.go.textContent = !unlocked
      ? `UNLOCK · ${UNLOCK_COST[name]} ✦`
      : state.net === "coop"
        ? "JOIN CO-OP"
        : state.net === "vs"
          ? "ENTER DUEL"
          : "DESCEND";
    this.go.dataset.locked = String(!unlocked);
    this.coop.setAttribute("aria-pressed", String(state.net === "coop"));
    this.versus.setAttribute("aria-pressed", String(state.net === "vs"));
    this.connection.hidden = state.net === "off";
    this.connection.textContent =
      state.net === "off"
        ? ""
        : `${state.net === "vs" ? "VERSUS" : "CO-OP"} ${state.code} · Share this page’s URL. Both ${state.net === "vs" ? "enter duel. First to 3 rounds." : "join co-op."}`;
    this.hint.textContent = state.coarse
      ? "Choose a warrior. Tap again or use the action above."
      : "← → choose · SPACE / J descend · U unlock · M forge · C / V online";
    const groups = controlGroups(CONTROLS, { coarse: state.coarse });
    const signature = JSON.stringify(groups);
    if (signature !== this.controlsSignature) {
      this.controlsSignature = signature;
      this.controls.replaceChildren();
      for (const group of groups) {
        const line = element("p", "lf-hub-control-line");
        const actions = new Map<string, string[]>();
        for (const entry of group.entries) {
          const inputs = actions.get(entry.action) ?? [];
          if (!inputs.includes(entry.input)) inputs.push(entry.input);
          actions.set(entry.action, inputs);
        }
        for (const [action, inputs] of actions) {
          const pair = element("span", "");
          pair.append(
            element("kbd", "", inputs.join(" / ")),
            document.createTextNode(` ${action}`),
          );
          line.append(pair);
        }
        this.controls.append(line);
      }
    }
    if (state.shop) {
      this.forgeBank.textContent = `✦ ${state.meta.shards} SHARDS`;
      for (const [index, up] of UPGRADES.entries()) {
        const row = this.rows[index];
        if (!row) continue;
        const level = upgradeLevel(state.meta, up.id);
        const maxed = level >= up.max;
        row.setAttribute("aria-pressed", String(index === state.shop.index));
        row.dataset.affordable = String(!maxed && state.meta.shards >= up.cost(level));
        const texts = [
          up.name,
          maxed ? "MAX" : `${up.cost(level)} ✦`,
          up.desc,
          `${level} / ${up.max}`,
        ];
        for (const [i, child] of Array.from(row.children).entries())
          child.textContent = texts[i] ?? "";
      }
      if (!this.dialog.open) {
        this.dialog.showModal();
        this.dialog.focus({ preventScroll: true });
      }
    } else if (this.dialog.open) {
      this.dialog.close();
      this.forge.focus({ preventScroll: true });
    }
  }

  focusSelection(): void {
    (this.dialog.open ? this.dialog : this.root).focus({ preventScroll: true });
  }

  announce(message: string): void {
    this.status.textContent = message;
    this.forgeStatus.textContent = message;
  }

  destroy(): void {
    this.observer.disconnect();
    this.unseal();
    this.dialog.close();
    this.root.remove();
    document.body.classList.remove("lf-in-hub");
  }
}

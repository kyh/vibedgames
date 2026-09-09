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
  inviteUrl: string;
  shop: { index: number } | null;
  coarse: boolean;
}>;
export type HubActions = Readonly<{
  hero: (index: number) => void;
  go: () => void;
  forge: () => void;
  offer: (index: number) => void;
  mode: (mode: "off" | "coop" | "vs") => void;
  join: (code: string) => void;
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
 * purchase. Empty hero stages reveal the animated Phaser sprites behind. */
export class HubView {
  readonly root = element("section", "lf-hub");
  readonly heroes: HTMLButtonElement[] = [];
  readonly showcase: HTMLElement = element("div", "lf-hub-showcase");
  private readonly content = element("div", "lf-hub-content");
  private readonly bank = element("div", "lf-hub-bank");
  private readonly title = element("h2", "lf-hub-hero-title");
  private readonly blurb = element("p", "lf-hub-blurb");
  private readonly controls = element("div", "lf-hub-controls");
  private readonly connection = element("p", "lf-hub-connection");
  private readonly go: HTMLButtonElement;
  private readonly solo: HTMLButtonElement;
  private readonly help: HTMLButtonElement;
  private readonly helpDialog = element("dialog", "lf-hub-help");
  private readonly records = element("p", "lf-hub-records");
  private readonly room = element("section", "lf-hub-room");
  private readonly roomCode = element("strong", "lf-hub-code");
  private readonly joinInput = element("input", "lf-hub-code-input");
  private readonly copy: HTMLButtonElement;
  private readonly linkFallback = element("label", "lf-hub-link-fallback", "Invite link");
  private readonly linkInput = element("input", "lf-hub-link-input");
  private readonly heldKeys = new Set<string>();
  private inviteUrl = "";
  private disposed = false;
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
    const mast = element("header", "lf-hub-mast");
    this.forge = button("FORGE", actions.forge);
    this.help = button("HELP", () => this.openHelp());
    this.help.setAttribute("aria-haspopup", "dialog");
    this.help.setAttribute("aria-expanded", "false");
    this.help.setAttribute("aria-controls", "lf-hub-help");
    const utilities = element("nav", "lf-hub-utilities");
    utilities.setAttribute("aria-label", "Forge and controls");
    utilities.append(this.forge, this.help);
    mast.append(this.bank, utilities);
    this.content.append(mast);

    const roster = element("section", "lf-hub-roster");
    roster.setAttribute("aria-label", "Choose your warrior");
    this.showcase.setAttribute("aria-hidden", "true");
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
    roster.append(this.showcase, this.title, this.blurb, grid);

    const tools = element("section", "lf-hub-tools");
    tools.setAttribute("aria-label", "Play options");
    this.solo = button("SOLO", () => actions.mode("off"));
    this.coop = button("CO-OP", () => actions.mode("coop"));
    this.versus = button("VERSUS", () => actions.mode("vs"));
    const modes = element("div", "lf-hub-modes");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "Game mode");
    modes.append(this.solo, this.coop, this.versus);

    this.room.setAttribute("aria-label", "Room invitation");
    const share = element("div", "lf-hub-share");
    const code = element("div", "lf-hub-code-box");
    code.append(element("span", "", "CODE:"), this.roomCode);
    this.copy = button(
      "COPY LINK",
      () => {
        void this.copyInvite();
      },
      "lf-hub-button lf-hub-copy",
    );
    share.append(code, this.copy);
    const join = element("form", "lf-hub-join");
    const label = element("label", "lf-hub-join-label", "Join a room");
    label.htmlFor = "lf-room-code";
    this.joinInput.id = "lf-room-code";
    this.joinInput.name = "room-code";
    this.joinInput.type = "text";
    this.joinInput.inputMode = "text";
    this.joinInput.maxLength = 4;
    this.joinInput.placeholder = "ENTER CODE";
    this.joinInput.autocomplete = "off";
    this.joinInput.autocapitalize = "characters";
    this.joinInput.spellcheck = false;
    const joinButton = element("button", "lf-hub-button lf-hub-join-button", "JOIN");
    joinButton.type = "submit";
    join.append(label, this.joinInput, joinButton);
    join.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!this.disposed) actions.join(this.joinInput.value);
    });
    this.linkInput.type = "text";
    this.linkInput.readOnly = true;
    this.linkInput.setAttribute("aria-label", "Full invite link. Select and copy.");
    this.linkFallback.append(this.linkInput);
    this.linkFallback.hidden = true;
    this.room.append(share, join, this.linkFallback);
    this.room.hidden = true;
    this.go = button("PLAY", actions.go, "lf-hub-button lf-hub-go");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    tools.append(modes, this.room, this.connection, this.go, this.status);
    this.content.append(roster, tools);

    if (recap) {
      const receipt = element("details", "lf-hub-receipt");
      receipt.setAttribute("aria-label", "Last descent receipt");
      const summary = element("summary", "");
      summary.append(
        element(
          "span",
          "",
          `${recap.kind === "coop-guest" ? "CO-OP DESCENT" : "LAST DESCENT"} · ${HEROES[recap.hero].title}`,
        ),
        element(
          "span",
          "lf-hub-reward",
          recap.kind === "banked" ? `+${recap.shardsEarned} ✦` : `DEPTH ${recap.depth}`,
        ),
      );
      receipt.append(
        summary,
        element("p", "", `BIOME ${recap.biome} · DEPTH ${recap.depth} · GOLD ${recap.gold}`),
      );
      if (recap.kind === "banked")
        receipt.append(
          element("p", "lf-hub-reward", `SCORE ${recap.score} · BEST ${recap.bestScore}`),
        );
      this.content.append(receipt);
    }
    this.root.append(this.content);

    const helpHead = element("header", "lf-hub-forge-head");
    helpHead.append(
      element("h2", "", "HOW TO PLAY"),
      button("CLOSE", () => this.closeHelp()),
    );
    this.helpDialog.id = "lf-hub-help";
    this.helpDialog.setAttribute("aria-label", "Lunerfall controls and game modes");
    this.helpDialog.tabIndex = -1;
    this.helpDialog.append(
      helpHead,
      element("p", "lf-hub-help-intro", "Choose a warrior, then Play."),
      this.controls,
      element(
        "p",
        "lf-hub-help-modes",
        "Solo: your descent. Co-op: descend together. Versus: first to three rounds.",
      ),
      this.hint,
      this.records,
    );
    this.helpDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeHelp();
    });
    this.root.append(this.helpDialog);

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
      keepClick: (target) =>
        target instanceof Element &&
        target.closest("button, input, textarea, label, summary") !== null,
    });
    this.root.addEventListener("keydown", this.fenceKey);
    this.root.addEventListener("keyup", this.fenceKey);
    this.observer = new ResizeObserver(actions.layout);
    this.observer.observe(this.root);
    this.observer.observe(this.content);
    this.observer.observe(this.showcase);
    this.observer.observe(grid);
    this.root.addEventListener("scroll", actions.layout);
    void document.fonts.ready.then(() => {
      if (!this.disposed) actions.layout();
    });
  }

  private readonly fenceKey = (event: KeyboardEvent): void => {
    const key = event.code || event.key;
    const editing =
      event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    const activation =
      (event.target instanceof HTMLButtonElement ||
        (event.target instanceof Element && event.target.closest("summary") !== null)) &&
      (event.key === "Enter" || event.key === " ");
    if (this.helpDialog.open || editing || activation || this.heldKeys.has(key)) {
      event.stopPropagation();
      if (event.type === "keydown") this.heldKeys.add(key);
      else this.heldKeys.delete(key);
      if (this.helpDialog.open && event.key === "Escape") {
        event.preventDefault();
        if (event.type === "keydown") this.closeHelp();
      }
    }
  };

  private openHelp(): void {
    if (this.disposed || this.helpDialog.open) return;
    this.helpDialog.showModal();
    this.help.setAttribute("aria-expanded", "true");
    this.helpDialog.focus({ preventScroll: true });
  }

  private closeHelp(): void {
    if (!this.helpDialog.open) return;
    this.helpDialog.close();
    this.help.setAttribute("aria-expanded", "false");
    this.help.focus({ preventScroll: true });
  }

  blocksGameInput(): boolean {
    return (
      this.helpDialog.open ||
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement
    );
  }

  private async copyInvite(): Promise<void> {
    const url = this.inviteUrl;
    if (this.disposed || !url) return;
    try {
      await navigator.clipboard.writeText(url);
      if (this.disposed || this.inviteUrl !== url) return;
      this.copy.textContent = "COPIED";
      this.announce("Invite link copied.");
    } catch {
      if (this.disposed || this.inviteUrl !== url) return;
      this.linkInput.value = url;
      this.linkFallback.hidden = false;
      this.announce("Select and copy the invite link below.");
      this.linkInput.focus({ preventScroll: true });
      this.linkInput.select();
    }
  }

  update(state: HubState): void {
    const name = HERO_ORDER[state.index];
    if (!name) return;
    const def = HEROES[name];
    const unlocked = isUnlocked(state.meta, name);
    this.bank.textContent = `✦ ${state.meta.shards} SHARDS`;
    this.records.textContent = `BEST DEPTH ${state.meta.bestDepth} · BEST SCORE ${state.bestScore}`;
    this.root.dataset.mode = state.net;
    this.root.dataset.hero = name;
    this.showcase.style.setProperty("--hero", `#${def.color.toString(16).padStart(6, "0")}`);
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
            : "";
    }
    this.go.textContent = !unlocked ? `UNLOCK · ${UNLOCK_COST[name]} ✦` : "PLAY";
    this.go.dataset.locked = String(!unlocked);
    this.solo.setAttribute("aria-pressed", String(state.net === "off"));
    this.coop.setAttribute("aria-pressed", String(state.net === "coop"));
    this.versus.setAttribute("aria-pressed", String(state.net === "vs"));
    if (state.net === "off" && this.room.contains(document.activeElement))
      this.root.focus({ preventScroll: true });
    this.room.hidden = state.net === "off";
    this.roomCode.textContent = state.code;
    if (this.inviteUrl !== state.inviteUrl) {
      this.inviteUrl = state.inviteUrl;
      this.copy.textContent = "COPY LINK";
      if (document.activeElement === this.linkInput && state.net !== "off")
        this.copy.focus({ preventScroll: true });
      this.linkFallback.hidden = true;
    }
    this.connection.textContent =
      state.net === "vs" ? "FIRST TO 3 ROUNDS" : state.net === "coop" ? "DESCEND TOGETHER" : "";
    this.connection.hidden = state.net === "off";
    this.hint.textContent = state.coarse
      ? "Use the on-screen controls during your descent."
      : "← → choose · SPACE / J play · U unlock · M forge · C / V online";
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
      if (this.helpDialog.open) this.closeHelp();
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
        this.forgeStatus.textContent = "";
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
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.root.removeEventListener("keydown", this.fenceKey);
    this.root.removeEventListener("keyup", this.fenceKey);
    this.heldKeys.clear();
    this.helpDialog.close();
    this.unseal();
    this.dialog.close();
    this.root.remove();
    document.body.classList.remove("lf-in-hub");
  }
}

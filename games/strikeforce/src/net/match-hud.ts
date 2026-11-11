// The deathmatch readout, in the game's #ui layer and styled in style.css
// under "mx": a bar (your kills · the clock · the leader's kills), and a
// scoreboard while Tab is held. Redraws only on change.
import { RULES, standings } from "./rules";
import type { Fighter, MatchState } from "./rules";

export interface HudView {
  match: MatchState | null;
  me: string;
  /** The server clock, ms. */
  now: number;
  status: string;
  title: boolean;
  callsign: (id: string) => string;
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const phaseLine = (m: MatchState, callsign: (id: string) => string): string => {
  if (m.phase === "warmup") {
    return "Warmup · waiting for another player";
  }
  if (m.phase === "over") {
    return `${callsign(m.champ)} takes it`;
  }
  return `Deathmatch · first to ${RULES.kills}`;
};

const statusLine = (status: string): string => {
  if (status === "connecting") {
    return "Finding a match";
  }
  return status === "offline" ? "Offline · warmup" : "";
};

const el = (tag: string, cls: string, text = ""): HTMLElement => {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
};

/** Your kills · the clock · whoever you are chasing (the leader, or second place while you lead). */
const killRow = (
  m: MatchState,
  view: HudView,
  ranks: readonly [string, Fighter][],
  left: string,
): HTMLElement => {
  const mine = m.roster.get(view.me)?.kills ?? 0;
  const leading = ranks[0]?.[0] === view.me;
  const lead = ranks.find(([id]) => id !== view.me);
  const you = el("div", "mx-team t0");
  you.append(el("b", "", "You"), el("span", "", leading ? "leading" : "kills"));
  const them = el("div", "mx-team t1");
  them.append(
    el("b", "", lead ? view.callsign(lead[0]) : "—"),
    el("span", "", leading ? "2nd" : "leader"),
  );
  const mid = el("div", "mx-mid");
  mid.append(
    el("strong", "", `${mine}`),
    el("em", "", left || "—"),
    el("strong", "", `${lead?.[1].kills ?? 0}`),
  );
  const row = el("div", "mx-row");
  row.append(you, mid, them);
  return row;
};

export class MatchHud {
  private bar: HTMLElement | null = null;
  private board: HTMLElement | null = null;
  private drawnBar = "";
  private drawnBoard = "";
  private boardOpen = false;

  mount(): void {
    const ui = document.querySelector("#ui");
    if (!ui) {
      return;
    }
    this.bar = el("div", "mx");
    this.bar.setAttribute("aria-live", "polite");
    this.board = el("div", "mx-board");
    this.board.setAttribute("role", "dialog");
    this.board.setAttribute("aria-label", "Scoreboard");
    ui.append(this.bar, this.board);
    const toggle = (open: boolean) => (event: KeyboardEvent) => {
      if (event.code !== "Tab") {
        return;
      }
      event.preventDefault();
      this.boardOpen = open;
    };
    addEventListener("keydown", toggle(true));
    addEventListener("keyup", toggle(false));
  }

  update(view: HudView): void {
    this.drawBar(view);
    this.drawBoard(view);
  }

  private drawBar(view: HudView): void {
    const { bar } = this;
    if (!bar) {
      return;
    }
    const m = view.match;
    const left = m && m.ends > 0 && m.phase !== "warmup" ? clock(m.ends - view.now) : "";
    const status = statusLine(view.status);
    const ranks = m ? standings(m) : [];
    const order = ranks.map(([id, f]) => `${id}:${f.kills}`).join(",");
    const key = m
      ? `${m.phase}|${m.round}|${left}|${order}|${m.champ}|${view.title ? 1 : 0}`
      : `${status}|${view.title ? 1 : 0}`;
    if (key === this.drawnBar) {
      return;
    }
    this.drawnBar = key;
    bar.classList.toggle("on", !view.title && Boolean(m || status));
    bar.replaceChildren();
    if (!m) {
      bar.append(el("div", "mx-line", status));
      return;
    }
    bar.append(killRow(m, view, ranks, left), el("div", "mx-line", phaseLine(m, view.callsign)));
  }

  private drawBoard(view: HudView): void {
    const { board } = this;
    const m = view.match;
    if (!board) {
      return;
    }
    const open = this.boardOpen && Boolean(m) && !view.title;
    const rows =
      m && open
        ? [...m.roster]
            .map(([id, f]) => `${id}:${f.alive ? 1 : 0}:${f.kills}:${f.deaths}`)
            .join(",")
        : "";
    const key = `${open ? 1 : 0}|${rows}`;
    if (key === this.drawnBoard) {
      return;
    }
    this.drawnBoard = key;
    board.classList.toggle("on", open);
    board.replaceChildren();
    if (!m || !open) {
      return;
    }
    const col = el("section", "mx-col");
    col.append(el("h3", "", "Deathmatch"));
    for (const [id, f] of standings(m)) {
      const row = el("div", `mx-player${f.alive ? "" : " dead"}${id === view.me ? " me" : ""}`);
      row.append(
        el("b", "", view.callsign(id)),
        el("span", "", `${f.kills}`),
        el("span", "", `${f.deaths}`),
      );
      col.append(row);
    }
    board.append(col);
  }
}

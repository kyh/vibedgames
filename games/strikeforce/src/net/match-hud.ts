// The match readout, in the game's #ui layer and styled in style.css under
// "mx": a score bar (Gold score · round clock · Steel score, with a pip per
// player alive), and a scoreboard while Tab is held. Redraws only on change.
import { TEAM_NAME } from "./protocol";
import { RULES } from "./rules";
import type { Fighter, MatchState, Team } from "./rules";

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

const dmLine = (m: MatchState, callsign: (id: string) => string): string => {
  if (m.phase === "warmup") {
    return "Warmup · waiting for another player";
  }
  if (m.phase === "over") {
    return `${callsign(m.champ)} takes it`;
  }
  return `Deathmatch · first to ${RULES.dmKills}`;
};

const phaseLine = (m: MatchState): string => {
  if (m.phase === "warmup") {
    return "Warmup · waiting for both sides";
  }
  if (m.phase === "freeze") {
    return `Round ${m.round} · get set`;
  }
  if (m.phase === "planted") {
    return "Charge planted";
  }
  if (m.phase === "post" && m.last) {
    return `${TEAM_NAME[m.last.winner]} takes round ${m.round}`;
  }
  if (m.phase === "over") {
    return `${TEAM_NAME[m.score[0] > m.score[1] ? 0 : 1]} wins the match`;
  }
  return `Round ${m.round}`;
};

const statusLine = (status: string): string => {
  if (status === "connecting") {
    return "Finding a match";
  }
  return status === "offline" ? "Offline · warmup" : "";
};

const roleOf = (m: MatchState, team: Team): string => (team === m.attack ? "attack" : "defend");

const el = (tag: string, cls: string, text = ""): HTMLElement => {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
};

/** Deathmatch bar: your kills · the clock · the leader's kills. */
const dmBar = (m: MatchState, view: HudView, left: string): HTMLElement => {
  const fighters = [...m.roster];
  const mine = m.roster.get(view.me)?.kills ?? 0;
  const [leadId, lead] = fighters.toSorted(([, a], [, b]) => b.kills - a.kills)[0] ?? ["", null];
  const box = el("div", "mx-dm");
  const row = el("div", "mx-row");
  const you = el("div", "mx-team t0");
  you.append(el("b", "", "You"), el("span", "", "kills"));
  const them = el("div", "mx-team t1");
  them.append(el("b", "", lead ? view.callsign(leadId) : "—"), el("span", "", "leader"));
  const mid = el("div", "mx-mid");
  mid.append(
    el("strong", "", `${mine}`),
    el("em", "", left || "—"),
    el("strong", "", `${lead?.kills ?? 0}`),
  );
  row.append(you, mid, them);
  box.append(row, el("div", "mx-line", dmLine(m, view.callsign)));
  return box;
};

/** One scoreboard column: players by kills, then fewest deaths. */
const boardColumn = (title: string, fighters: [string, Fighter][], view: HudView): HTMLElement => {
  const col = el("section", "mx-col");
  col.append(el("h3", "", title));
  for (const [id, f] of fighters.toSorted(
    ([, a], [, b]) => b.kills - a.kills || a.deaths - b.deaths,
  )) {
    const row = el("div", `mx-player${f.alive ? "" : " dead"}${id === view.me ? " me" : ""}`);
    row.append(
      el("b", "", view.callsign(id)),
      el("span", "", `${f.kills}`),
      el("span", "", `${f.deaths}`),
    );
    col.append(row);
  }
  return col;
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
    const pips = (team: Team): string =>
      m
        ? [...m.roster.values()]
            .filter((f) => f.team === team)
            .map((f) => (f.alive ? "1" : "0"))
            .join("")
        : "";
    const left = m && m.ends > 0 && m.phase !== "warmup" ? clock(m.ends - view.now) : "";
    const status = statusLine(view.status);
    const kills = m ? [...m.roster.values()].map((f) => f.kills).join(",") : "";
    const key = m
      ? `${m.kind}|${m.score.join(":")}|${left}|${phaseLine(m)}|${pips(0)}|${pips(1)}|${m.attack}|${kills}|${m.champ}|${view.title ? 1 : 0}`
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
    if (m.kind === "dm") {
      bar.append(dmBar(m, view, left));
      return;
    }
    const side = (team: Team): HTMLElement => {
      const box = el("div", `mx-team t${team}`);
      const name = el("b", "", TEAM_NAME[team]);
      const role = el("span", "", roleOf(m, team));
      const alive = el("i", "mx-pips");
      for (const c of pips(team)) {
        alive.append(el("u", c === "1" ? "on" : ""));
      }
      box.append(name, role, alive);
      return box;
    };
    const mid = el("div", "mx-mid");
    mid.append(
      el("strong", "", `${m.score[0]}`),
      el("em", "", left || "—"),
      el("strong", "", `${m.score[1]}`),
    );
    const row = el("div", "mx-row");
    row.append(side(0), mid, side(1));
    bar.append(row, el("div", "mx-line", phaseLine(m)));
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
            .map(([id, f]) => `${id}:${f.team}:${f.alive ? 1 : 0}:${f.kills}:${f.deaths}`)
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
    if (m.kind === "dm") {
      board.classList.add("solo");
      board.append(boardColumn("Deathmatch", [...m.roster], view));
      return;
    }
    board.classList.remove("solo");
    for (const team of [0, 1] as const) {
      const col = el("section", `mx-col t${team}`);
      col.append(el("h3", "", `${TEAM_NAME[team]} · ${m.score[team]}`));
      const fighters = [...m.roster]
        .filter(([, f]) => f.team === team)
        .toSorted(([, a], [, b]) => b.kills - a.kills || a.deaths - b.deaths);
      for (const [id, f] of fighters) {
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
}

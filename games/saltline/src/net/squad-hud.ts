// The squad readout: one line of room status, then a row per squad member
// (callsign, health, where they are). Lives in the game's #ui layer, styled in
// style.css under "squad", and redraws only when what it shows changes.
import { PHASE } from "./protocol";
import type { Member } from "./squad";

export interface SquadView {
  members: readonly Member[];
  role: "solo" | "host" | "guest";
  room: string;
  status: string;
  title: boolean;
}

const statusLine = (view: SquadView): string => {
  const size = view.members.length + 1;
  if (view.status === "connecting") {
    return "Squad · finding a room";
  }
  if (view.role === "solo") {
    return view.title ? "Solo · no squad online" : "";
  }
  const lead = view.role === "host" ? " · you lead" : "";
  return `Squad ${size}/4${lead}`;
};

const memberState = (member: Member): string => {
  if (!member.connected) {
    return "link lost";
  }
  if (member.phase === PHASE.down) {
    return "down";
  }
  if (member.phase === PHASE.extracted) {
    return "on the boat";
  }
  if (member.phase === PHASE.menu) {
    return "at the dock";
  }
  return "";
};

export class SquadHud {
  private root: HTMLElement | null = null;
  private drawn = "";

  mount(): void {
    const ui = document.querySelector("#ui");
    if (!ui) {
      return;
    }
    this.root = document.createElement("div");
    this.root.className = "squad";
    this.root.setAttribute("aria-live", "polite");
    ui.append(this.root);
  }

  update(view: SquadView): void {
    const { root } = this;
    if (!root) {
      return;
    }
    const line = statusLine(view);
    const rows = view.members.map(
      (m) => `${m.callsign}|${memberState(m)}|${Math.round(m.hp / 10)}`,
    );
    const key = `${line}#${rows.join(",")}#${view.title ? 1 : 0}`;
    if (key === this.drawn) {
      return;
    }
    this.drawn = key;
    root.classList.toggle("on", line !== "");
    root.classList.toggle("title", view.title);
    root.replaceChildren();
    if (!line) {
      return;
    }
    const head = document.createElement("div");
    head.className = "squad-k";
    head.textContent = line;
    root.append(head);
    for (const member of view.members) {
      root.append(memberRow(member));
    }
  }
}

const memberRow = (member: Member): HTMLElement => {
  const row = document.createElement("div");
  row.className = "squad-row";
  const name = document.createElement("b");
  name.textContent = member.callsign;
  row.append(name);
  const state = memberState(member);
  if (state) {
    const tag = document.createElement("span");
    tag.textContent = state;
    row.append(tag);
  } else {
    const bar = document.createElement("i");
    bar.style.setProperty("--hp", String(Math.max(0, Math.min(1, member.hp / 100))));
    row.append(bar);
  }
  return row;
};

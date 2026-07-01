// Pre-match lobby (?menu). The champion roster stands as 3D models on an arc
// (rendered by MenuStage); this DOM overlay sits on top with the logo, the
// selected champion's info panel (ability-icon strip + blurb), the select
// cards (sigil / name / role / difficulty), name/room inputs and the play
// buttons. The overlay is click-through except on its controls, so clicks in
// the middle reach the 3D row for selection. START persists the pick to
// localStorage["ba-champ"] / ["ba-name"] for future quick-start boots.
import { CHAMPIONS } from "../data/champions";
import { abilityIcon, champSigil } from "../data/icons";
import { ABILITY_KEYS, type AbilityKey } from "../sim/types";
import { roomId } from "../net/protocol";
import type { SceneOpts } from "./game-scene";

const hex = (n: number): string => "#" + n.toString(16).padStart(6, "0");
// escape user-supplied strings dropped into attribute values (name/room prefill)
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dots = (difficulty: number): string => "●".repeat(difficulty) + "○".repeat(Math.max(0, 3 - difficulty));
// display keycaps match the actual binds (1-4), not the QWER kit letters
const KEYCAP: Record<AbilityKey, string> = { Q: "1", W: "2", E: "3", R: "4" };

export type MenuOpts = {
  initial: string;
  onSelect: (id: string) => void;
  onStart: (opts: SceneOpts) => void;
};

export class Menu {
  private el: HTMLDivElement;
  private selected: string;

  constructor(private opts: MenuOpts) {
    this.selected = opts.initial;
    this.el = document.createElement("div");
    this.el.id = "ba-menu";
    document.body.appendChild(this.el);
    injectStyle();
    this.build();
  }

  private build(): void {
    const params = new URLSearchParams(location.search);
    const name = params.get("name") ?? localStorage.getItem("ba-name") ?? "";
    const chips = CHAMPIONS.map(
      (c) =>
        `<button class="ba-chip" data-id="${c.id}" style="--accent:${hex(c.tint)}">
          <img class="ba-cs" src="${champSigil(c.id)}" alt="">
          <span class="ba-cn">${c.name}</span>
          <span class="ba-cr">${c.role}</span>
          <span class="ba-cd2">${dots(c.difficulty)}</span>
        </button>`,
    ).join("");

    this.el.innerHTML = `
      <div class="ba-top">
        <div class="ba-logo">BATTLE ARENA</div>
        <div class="ba-tag">Contest the throne. Grab the coins. Don't let anyone run away with it.</div>
        <div class="ba-info" id="ba-info"></div>
      </div>
      <div class="ba-bottom">
        <div class="ba-chips">${chips}</div>
        <div class="ba-row2">
          <input id="ba-name" maxlength="14" placeholder="Your name" value="${esc(name)}" />
          <input id="ba-room" maxlength="12" placeholder="Room code (optional)" value="${esc(params.get("room") ?? "")}" />
        </div>
        <div class="ba-actions">
          <button id="ba-bots" class="ba-go bots">PLAY vs BOTS</button>
          <button id="ba-online" class="ba-go online">PLAY ONLINE</button>
        </div>
        <div class="ba-help">click a champion · WASD move · mouse looks · LMB attack · Space jump · Shift dodge · 1/2/3/4 abilities · B shop</div>
      </div>`;

    this.el.querySelectorAll<HTMLButtonElement>(".ba-chip").forEach((btn) => {
      btn.addEventListener("click", () => this.opts.onSelect(btn.dataset["id"]!));
    });

    const nameOf = (): string => (document.getElementById("ba-name") as HTMLInputElement).value.trim() || "Player";
    const codeOf = (): string => (document.getElementById("ba-room") as HTMLInputElement).value.trim();
    (document.getElementById("ba-bots") as HTMLButtonElement).addEventListener("click", () =>
      this.start({ champId: this.selected, name: nameOf(), online: false, room: "" }),
    );
    (document.getElementById("ba-online") as HTMLButtonElement).addEventListener("click", () =>
      this.start({ champId: this.selected, name: nameOf(), online: true, room: roomId(codeOf()) }),
    );

    this.setSelected(this.selected);
  }

  /** Reflect the current selection (called by MenuStage on click / chip click). */
  setSelected(id: string): void {
    this.selected = id;
    this.el.querySelectorAll<HTMLButtonElement>(".ba-chip").forEach((b) => {
      b.classList.toggle("sel", b.dataset["id"] === id);
    });
    const c = CHAMPIONS.find((x) => x.id === id);
    const info = document.getElementById("ba-info");
    if (c && info) {
      const ab = ABILITY_KEYS.map(
        (k) =>
          `<span class="ba-i-a"><img src="${abilityIcon(c.id, k)}" alt=""><i>${KEYCAP[k]}</i><em>${c.abilities[k].name}</em></span>`,
      ).join("");
      info.style.setProperty("--accent", hex(c.tint));
      info.innerHTML = `<span class="ba-i-name">${c.name}</span><span class="ba-i-title">${c.title}</span>
        <span class="ba-i-role">${c.role} · ${c.primary.toUpperCase()} · <span class="ba-i-diff">${dots(c.difficulty)}</span></span>
        <span class="ba-i-blurb">${c.blurb}</span>
        <span class="ba-i-abrow">${ab}</span>`;
    }
  }

  remove(): void {
    this.el.remove();
  }

  private start(opts: SceneOpts): void {
    // persist the pick — bare-URL quick-starts reuse it (chosenChamp/chosenName)
    localStorage.setItem("ba-champ", opts.champId);
    localStorage.setItem("ba-name", opts.name);
    this.remove();
    this.opts.onStart(opts);
  }
}

let styled = false;
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = `
#ba-menu{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none;font-family:ui-monospace,monospace;color:#fff}
#ba-menu .ba-top{text-align:center;padding:22px 16px 0;background:linear-gradient(#080a12cc,#080a1200)}
.ba-logo{font:900 italic clamp(34px,7vw,72px)/1 system-ui,sans-serif;letter-spacing:-2px;color:#ffd24a;text-shadow:0 0 50px rgba(255,160,40,.4)}
.ba-tag{margin:8px 0 14px;font:600 13px ui-monospace,monospace;opacity:.7}
.ba-info{min-height:150px;display:flex;flex-direction:column;align-items:center;gap:2px}
.ba-i-name{font:800 30px ui-monospace,monospace;color:var(--accent)}
.ba-i-title{font-size:13px;opacity:.7}
.ba-i-role{font-size:12px;letter-spacing:1px;opacity:.85;margin-top:4px}
.ba-i-diff{color:var(--accent);letter-spacing:2px}
.ba-i-blurb{font-size:12px;opacity:.65;margin-top:3px;max-width:520px;line-height:1.35}
.ba-i-abrow{display:flex;gap:10px;margin-top:8px;justify-content:center}
.ba-i-a{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;width:66px}
.ba-i-a img{width:40px;height:40px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:#0a0e1a}
.ba-i-a i{position:absolute;top:-5px;left:7px;font:800 9px ui-monospace,monospace;font-style:normal;color:#ffd24a;background:rgba(10,14,24,.92);border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:0 3px}
.ba-i-a em{font:600 9px ui-monospace,monospace;font-style:normal;opacity:.75;text-align:center;line-height:1.2}
#ba-menu .ba-bottom{padding:0 16px 22px;background:linear-gradient(#080a1200,#080a12dd 40%)}
.ba-chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:14px}
.ba-chip{pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:3px;width:104px;padding:10px 6px;background:rgba(20,26,42,.85);border:2px solid rgba(255,255,255,.12);border-radius:10px;color:#fff;cursor:pointer;font:800 13px ui-monospace,monospace;transition:transform .1s,border-color .1s,box-shadow .1s}
.ba-chip:hover{transform:translateY(-2px)}
.ba-chip.sel{border-color:var(--accent);color:var(--accent);box-shadow:0 0 20px -6px var(--accent);transform:translateY(-4px) scale(1.04)}
.ba-cs{width:44px;height:44px;border-radius:9px;border:2px solid var(--accent);background:#0a0e1a}
.ba-cn{font:800 13px ui-monospace,monospace}
.ba-cr{font:600 9px ui-monospace,monospace;letter-spacing:.5px;opacity:.65;text-transform:uppercase;text-align:center}
.ba-cd2{font-size:9px;color:var(--accent);letter-spacing:2px}
.ba-row2{display:flex;gap:10px;justify-content:center;margin-bottom:12px}
.ba-row2 input{pointer-events:auto;background:rgba(10,14,24,.85);border:2px solid rgba(255,255,255,.15);border-radius:10px;padding:11px 14px;color:#fff;font:600 15px ui-monospace,monospace;width:200px}
.ba-actions{display:flex;gap:12px;justify-content:center}
.ba-go{pointer-events:auto;font:800 17px ui-monospace,monospace;letter-spacing:1px;border:none;border-radius:12px;padding:15px 26px;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.4)}
.ba-go.bots{background:#3a7bd5;color:#fff}
.ba-go.online{background:#ffd24a;color:#14111a}
.ba-help{margin-top:16px;text-align:center;font:600 12px ui-monospace,monospace;opacity:.5}
`;
  document.head.appendChild(s);
}

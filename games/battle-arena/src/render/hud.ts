// DOM HUD: floating nameplates + HP bars, ability cooldowns, HP, match
// timer, leaderboard, kill feed, toasts, respawn overlay, end screen, shop.
// Reads the world each frame; never mutates the sim.
import { CHAMP_BY_ID, valAt } from "../data/champions";
import { ITEMS, ITEM_BY_ID, MAX_ITEMS, type ItemDef } from "../data/items";
import { KILL_GOAL_FFA } from "../data/config";
import { ARENA, HALF, OBSTACLES, isInThrone } from "../data/map";
import { ABILITY_KEYS, type AbilityKey, type Unit, type World } from "../sim/types";
import type { Fx } from "./fx";
import { LOCAL_COLOR, teamColor } from "./palette";
import type { View } from "./view";

const KEYCAP: Record<AbilityKey, string> = { Q: "1", W: "2", E: "3", R: "4" };

function hex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}

export type ShopCallbacks = {
  buy: (itemId: string) => void;
  canShop: () => boolean;
};

export class Hud {
  private root: HTMLElement;
  private plates = new Map<string, { wrap: HTMLDivElement; fill: HTMLDivElement; name: HTMLDivElement }>();
  private timerEl!: HTMLElement;
  private goalEl!: HTMLElement;
  private boardEl!: HTMLElement;
  private feedEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private hpFill!: HTMLElement;
  private hpText!: HTMLElement;
  private goldEl!: HTMLElement;
  private lvlEl!: HTMLElement;
  private abilityEls = new Map<AbilityKey, { wrap: HTMLElement; cd: HTMLElement; cdText: HTMLElement }>();
  private respawnEl!: HTMLElement;
  private itemsEl!: HTMLElement;
  private itemSig = "";
  private minimap!: HTMLCanvasElement;
  private mmCtx!: CanvasRenderingContext2D;
  private shopEl!: HTMLElement;
  private shopOpen = false;
  private endEl!: HTMLElement;
  private shownEnd = false;
  private lowHpEl: HTMLDivElement;

  constructor(
    private view: View,
    private fx: Fx,
    private shop: ShopCallbacks,
  ) {
    this.root = document.getElementById("hud")!;
    this.injectStyle();
    this.build();
    // persistent low-HP danger vignette (one reused node)
    this.lowHpEl = document.createElement("div");
    this.lowHpEl.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:7;opacity:0;transition:opacity .15s;" +
      "background:radial-gradient(ellipse at center, transparent 45%, rgba(190,20,20,0.85) 130%)";
    document.body.appendChild(this.lowHpEl);
  }

  // ── markup ──
  private build(): void {
    this.root.innerHTML = `
      <div id="ba-plates"></div>
      <div id="ba-top">
        <div id="ba-timer">8:00</div>
        <div id="ba-goal"></div>
      </div>
      <div id="ba-board"></div>
      <div id="ba-feed"></div>
      <div id="ba-toasts"></div>
      <div id="ba-bottom">
        <div id="ba-vitals">
          <div class="ba-bar hp"><div id="ba-hpfill"></div><span id="ba-hptext"></span></div>
        </div>
        <div id="ba-abilities"></div>
        <div id="ba-items"></div>
        <div id="ba-meta"><span id="ba-lvl">Lv1</span><span id="ba-gold">0</span></div>
      </div>
      <div id="ba-onboard"><b>REACH THE THRONE</b> · grab coins · first to ${KILL_GOAL_FFA} kills wins<br><span class="ba-ob-keys">WASD move · mouse looks · LMB attack · Space jump · Shift dodge · 1 2 3 4 abilities</span></div>
      <div id="ba-respawn" hidden></div>
      <canvas id="ba-minimap" width="150" height="150"></canvas>
      <div id="ba-shop" hidden></div>
      <div id="ba-end" hidden></div>`;

    this.timerEl = byId("ba-timer");
    this.goalEl = byId("ba-goal");
    this.boardEl = byId("ba-board");
    this.feedEl = byId("ba-feed");
    this.toastEl = byId("ba-toasts");
    this.hpFill = byId("ba-hpfill");
    this.hpText = byId("ba-hptext");
    this.goldEl = byId("ba-gold");
    this.lvlEl = byId("ba-lvl");
    this.respawnEl = byId("ba-respawn");
    this.itemsEl = byId("ba-items");
    this.minimap = byId("ba-minimap") as HTMLCanvasElement;
    this.mmCtx = this.minimap.getContext("2d")!;
    this.shopEl = byId("ba-shop");
    this.endEl = byId("ba-end");

    const abilEl = byId("ba-abilities");
    for (const key of ABILITY_KEYS) {
      const wrap = document.createElement("div");
      wrap.className = "ba-abil";
      wrap.innerHTML = `<div class="ba-cd"></div><div class="ba-key">${KEYCAP[key]}</div><div class="ba-cdtext"></div>`;
      abilEl.appendChild(wrap);
      this.abilityEls.set(key, {
        wrap,
        cd: wrap.querySelector(".ba-cd") as HTMLElement,
        cdText: wrap.querySelector(".ba-cdtext") as HTMLElement,
      });
    }
    this.buildShop();
  }

  private buildShop(): void {
    const rows = ITEMS.map(
      (it) =>
        `<button class="ba-item" data-id="${it.id}"><span class="ba-iname">${it.name}</span><span class="ba-idesc">${it.desc}</span><span class="ba-icost">${it.cost}g</span></button>`,
    ).join("");
    this.shopEl.innerHTML = `<div class="ba-shop-head">SHOP <span class="ba-shop-hint">(B to close · only in base)</span></div><div class="ba-shop-grid">${rows}</div>`;
    this.shopEl.querySelectorAll<HTMLButtonElement>(".ba-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (id) this.shop.buy(id);
      });
    });
  }

  toggleShop(): void {
    this.shopOpen = !this.shopOpen;
    this.shopEl.hidden = !this.shopOpen;
  }
  get isShopOpen(): boolean {
    return this.shopOpen;
  }

  // ── per-frame update ──
  update(w: World, me: Unit): void {
    this.updateLowHp(w, me);
    this.updatePlates(w, me);
    this.updateVitals(me);
    this.updateAbilities(w, me);
    this.updateItems(w, me);
    this.updateTop(w);
    this.updateBoard(w, me);
    this.updateRespawn(w, me);
    this.updateOnboard(w);
    this.drawMinimap(w, me);
    this.drainFeed();
    this.updateShop(me);
    this.updateEnd(w, me);
  }

  dispose(): void {
    this.lowHpEl.remove();
  }

  /** Red danger vignette that intensifies below 35% HP, with a heartbeat throb
   *  under 20%. One reused node; opacity only. */
  private updateLowHp(w: World, me: Unit): void {
    const frac = me.alive ? me.hp / Math.max(1, me.maxHp) : 1;
    let op = 0;
    if (frac < 0.35) {
      op = ((0.35 - frac) / 0.35) * 0.55;
      if (frac < 0.2) op *= 0.8 + 0.2 * Math.sin(w.now * 0.006);
    }
    this.lowHpEl.style.opacity = op.toFixed(3);
  }

  private drawMinimap(w: World, me: Unit): void {
    const ctx = this.mmCtx;
    const N = this.minimap.width;
    const c = N / 2;
    const scale = (N / 2 - 4) / HALF;
    const to = (x: number, y: number): [number, number] => [c + x * scale, c + y * scale];
    ctx.clearRect(0, 0, N, N);
    // arena disc
    ctx.beginPath();
    ctx.arc(c, c, N / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(14,18,28,0.78)";
    ctx.fill();
    ctx.strokeStyle = "rgba(120,140,180,0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // throne aura
    const [tx, ty] = to(ARENA.throne.x, ARENA.throne.y);
    ctx.beginPath();
    ctx.arc(tx, ty, ARENA.throne.radius * scale, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,210,74,0.7)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // pillars
    ctx.fillStyle = "rgba(120,120,140,0.45)";
    for (const o of OBSTACLES) {
      const [px, py] = to(o.x, o.y);
      ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
    }
    // deliveries
    for (const d of w.deliveries) {
      const [dx, dy] = to(d.x, d.y);
      ctx.fillStyle = "#66ffcc";
      ctx.fillRect(dx - 2.5, dy - 2.5, 5, 5);
    }
    // coins
    for (const coin of w.coins) {
      const [cx, cy] = to(coin.x, coin.y);
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd24a";
      ctx.fill();
    }
    // heroes
    for (const u of w.units.values()) {
      if (u.kind !== "hero" || !u.alive) continue;
      const [ux, uy] = to(u.x, u.y);
      const isLocal = u.id === me.id;
      ctx.beginPath();
      ctx.arc(ux, uy, isLocal ? 3.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = isLocal ? hex(LOCAL_COLOR) : hex(teamColor(u.team));
      ctx.fill();
      if (w.leaderId === u.team) {
        ctx.strokeStyle = "#ffd24a";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (isLocal) {
        // heading wedge so the world-locked minimap relates to facing
        const a = Math.atan2(u.aimX, u.aimY);
        ctx.beginPath();
        ctx.moveTo(ux + Math.sin(a) * 8, uy + Math.cos(a) * 8);
        ctx.lineTo(ux + Math.sin(a + 2.5) * 4, uy + Math.cos(a + 2.5) * 4);
        ctx.lineTo(ux + Math.sin(a - 2.5) * 4, uy + Math.cos(a - 2.5) * 4);
        ctx.closePath();
        ctx.fillStyle = hex(LOCAL_COLOR);
        ctx.fill();
      }
    }
  }

  private updatePlates(w: World, me: Unit): void {
    const seen = new Set<string>();
    for (const u of w.units.values()) {
      if ((u.kind !== "hero" && u.kind !== "creep") || !u.alive) continue;
      const stealthed = u.statuses.some((s) => s.kind === "stealth") && u.id !== me.id;
      if (stealthed) continue;
      // only show skeleton HP bars when they're near the player (avoid clutter)
      if (u.kind === "creep" && (u.x - me.x) ** 2 + (u.y - me.y) ** 2 > 22 * 22) continue;
      seen.add(u.id);
      let plate = this.plates.get(u.id);
      if (!plate) {
        const wrap = document.createElement("div");
        wrap.className = "ba-plate" + (u.kind === "creep" ? " creep" : "");
        const isLocal = u.id === me.id;
        const col = u.kind === "creep" ? "#b8c0d0" : isLocal ? hex(LOCAL_COLOR) : hex(teamColor(u.team));
        const name = u.kind === "creep" ? "" : u.name;
        wrap.innerHTML = `<div class="ba-pname" style="color:${col}">${name}</div><div class="ba-php"><div class="ba-phpfill" style="background:${u.kind === "creep" ? "#c8a0a0" : u.team === me.team ? "#5dd66b" : "#ff5a52"}"></div></div>`;
        byId("ba-plates").appendChild(wrap);
        plate = {
          wrap,
          fill: wrap.querySelector(".ba-phpfill") as HTMLDivElement,
          name: wrap.querySelector(".ba-pname") as HTMLDivElement,
        };
        this.plates.set(u.id, plate);
      }
      const s = this.view.worldToScreen(u.x, u.y);
      if (s.visible) {
        plate.wrap.style.display = "block";
        plate.wrap.style.left = `${s.x}px`;
        plate.wrap.style.top = `${s.y - 56}px`;
        plate.fill.style.width = `${Math.max(0, (u.hp / u.maxHp) * 100)}%`;
      } else {
        plate.wrap.style.display = "none";
      }
    }
    for (const [id, plate] of this.plates) {
      if (!seen.has(id)) {
        plate.wrap.remove();
        this.plates.delete(id);
      }
    }
  }

  private updateVitals(me: Unit): void {
    this.hpFill.style.width = `${Math.max(0, (me.hp / me.maxHp) * 100)}%`;
    this.hpText.textContent = `${Math.max(0, Math.ceil(me.hp))} / ${Math.ceil(me.maxHp)}`;
    this.goldEl.textContent = `${Math.floor(me.gold)}g`;
    this.lvlEl.textContent = `Lv${me.level}`;
  }

  private updateAbilities(w: World, me: Unit): void {
    const def = CHAMP_BY_ID[me.champId]!;
    for (const key of ABILITY_KEYS) {
      const el = this.abilityEls.get(key)!;
      const slot = me.abilities[key];
      const ad = def.abilities[key];
      if (slot.rank < 1) {
        el.wrap.classList.add("locked");
        el.cd.style.background = "";
        el.cdText.textContent = key === "R" ? "Lv4" : "";
        continue;
      }
      el.wrap.classList.remove("locked");
      const cdLeft = Math.max(0, (slot.readyAt - w.now) / 1000);
      const cdTotal = valAt(ad.cooldown, slot.rank);
      const frac = cdLeft > 0 ? cdLeft / cdTotal : 0;
      el.cd.style.height = `${frac * 100}%`;
      el.cdText.textContent = cdLeft > 0 ? cdLeft.toFixed(1) : "";
    }
  }

  private readonly ITEM_KEYS = ["5", "6", "7", "8", "9", "0"];
  private updateItems(w: World, me: Unit): void {
    const sig = me.items.join(",");
    if (sig !== this.itemSig) {
      this.itemSig = sig;
      this.itemsEl.innerHTML = me.items
        .map((id, i) => {
          const it = ITEM_BY_ID[id];
          const active = it?.active ? " active" : "";
          return `<div class="ba-item-chip${active}" data-slot="${i}"><span class="ba-ik">${this.ITEM_KEYS[i] ?? ""}</span><span class="ba-in">${(it?.name ?? "?").slice(0, 3)}</span><div class="ba-icd"></div></div>`;
        })
        .join("");
    }
    // update active-item cooldown overlays
    this.itemsEl.querySelectorAll<HTMLElement>(".ba-item-chip").forEach((chip) => {
      const i = Number(chip.dataset.slot);
      const id = me.items[i];
      const it = id ? ITEM_BY_ID[id] : undefined;
      const cd = chip.querySelector(".ba-icd") as HTMLElement;
      if (it?.active) {
        const left = Math.max(0, ((me.itemReadyAt[id!] ?? 0) - w.now) / 1000);
        cd.style.height = it.active.cooldown > 0 ? `${(left / it.active.cooldown) * 100}%` : "0";
        cd.textContent = left > 0 ? left.toFixed(0) : "";
      }
    });
  }

  private updateTop(w: World): void {
    const remain = Math.max(0, w.matchTime - w.gameTime);
    const m = Math.floor(remain / 60);
    const s = Math.floor(remain % 60);
    this.timerEl.textContent = `${m}:${s.toString().padStart(2, "0")}`;
    this.timerEl.classList.toggle("low", remain < 30);
    this.goalEl.textContent = w.suddenDeath ? "SUDDEN DEATH" : `FIRST TO ${w.killGoal}`;
  }

  private updateBoard(w: World, me: Unit): void {
    const heroes = [...w.units.values()]
      .filter((u) => u.kind === "hero")
      .sort((a, b) => b.kills - a.kills || b.gold - a.gold)
      .slice(0, 6);
    this.boardEl.innerHTML = heroes
      .map((u) => {
        const col = u.id === me.id ? hex(LOCAL_COLOR) : hex(teamColor(u.team));
        const lead = w.leaderId === u.team ? "★" : "";
        return `<div class="ba-row${u.id === me.id ? " me" : ""}"><span class="ba-dot" style="background:${col}"></span><span class="ba-rn">${lead}${u.name}</span><span class="ba-rk">${u.kills}/${u.deaths}</span></div>`;
      })
      .join("");
  }

  private updateRespawn(w: World, me: Unit): void {
    if (!me.alive && me.respawnAt > 0) {
      const left = Math.max(0, (me.respawnAt - w.now) / 1000);
      this.respawnEl.hidden = false;
      this.respawnEl.innerHTML = `<div class="ba-rtitle">YOU DIED</div><div class="ba-rtimer">${left.toFixed(1)}s</div>`;
    } else {
      this.respawnEl.hidden = true;
    }
  }

  private updateOnboard(w: World): void {
    const el = byId("ba-onboard");
    const t = w.gameTime;
    // visible for the first ~14s, fading out
    el.style.opacity = t < 11 ? "1" : t < 15 ? String((15 - t) / 4) : "0";
  }

  private drainFeed(): void {
    while (this.fx.feed.length) {
      const k = this.fx.feed.shift()!;
      const row = document.createElement("div");
      row.className = "ba-kill" + (k.leader ? " leader" : "");
      row.innerHTML = `<b>${k.killerName}</b> ✕ ${k.victimName}`;
      this.feedEl.appendChild(row);
      setTimeout(() => row.remove(), 5000);
      while (this.feedEl.childElementCount > 5) this.feedEl.firstElementChild?.remove();
    }
    while (this.fx.toasts.length) {
      const t = this.fx.toasts.shift()!;
      const el = document.createElement("div");
      el.className = "ba-toast " + t.kind;
      el.textContent = t.text;
      this.toastEl.appendChild(el);
      setTimeout(() => el.remove(), 2400);
    }
  }

  private updateShop(me: Unit): void {
    const inBase = this.shop.canShop();
    if (this.shopOpen && !inBase) this.toggleShop();
    if (!this.shopOpen) return;
    this.shopEl.querySelectorAll<HTMLButtonElement>(".ba-item").forEach((btn) => {
      const it = ITEM_BY_ID[btn.dataset.id ?? ""];
      const owned = me.items.length >= MAX_ITEMS;
      const afford = it ? me.gold >= it.cost : false;
      btn.classList.toggle("afford", afford && !owned);
      btn.disabled = !afford || owned;
    });
  }

  private updateEnd(w: World, me: Unit): void {
    if (w.phase !== "ended" || !w.winner) {
      if (this.shownEnd) {
        this.shownEnd = false;
        this.endEl.hidden = true;
      }
      return;
    }
    if (this.shownEnd) return;
    this.shownEnd = true;
    const won = w.winner === me.team;
    const winner = [...w.units.values()].find((u) => u.team === w.winner);
    this.endEl.hidden = false;
    this.endEl.innerHTML = `
      <div class="ba-end-card">
        <div class="ba-end-title" style="color:${won ? "#6bff8e" : "#ff6a6a"}">${won ? "VICTORY" : "DEFEAT"}</div>
        <div class="ba-end-sub">${winner?.name ?? "Someone"} wins the arena</div>
        <button class="ba-end-btn" onclick="location.reload()">PLAY AGAIN</button>
      </div>`;
  }

  // ── styles ──
  private injectStyle(): void {
    const s = document.createElement("style");
    s.textContent = STYLE;
    document.head.appendChild(s);
  }
}

function byId(id: string): HTMLElement {
  return document.getElementById(id)!;
}

const STYLE = `
[hidden]{display:none!important}
#ba-plates{position:absolute;inset:0}
.ba-plate{position:absolute;transform:translate(-50%,-50%);text-align:center;pointer-events:none;will-change:left,top}
.ba-pname{font:700 12px ui-monospace,monospace;text-shadow:0 1px 2px #000;white-space:nowrap}
.ba-php{width:54px;height:5px;margin:2px auto 0;background:rgba(0,0,0,.6);border-radius:3px;overflow:hidden}
.ba-phpfill{height:100%;width:100%;transition:width .12s}
#ba-top{position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);text-align:center;pointer-events:none}
#ba-timer{font:800 40px ui-monospace,monospace;color:#ffd24a;text-shadow:0 3px 0 rgba(0,0,0,.5);line-height:1;font-variant-numeric:tabular-nums}
#ba-timer.low{color:#ff5a52}
#ba-goal{font:700 12px ui-monospace,monospace;letter-spacing:2px;opacity:.8;margin-top:4px}
#ba-board{position:fixed;top:calc(12px + env(safe-area-inset-top));left:calc(12px + env(safe-area-inset-left));display:flex;flex-direction:column;gap:3px;pointer-events:none}
.ba-row{display:flex;align-items:center;gap:7px;background:rgba(12,16,26,.6);border-radius:6px;padding:3px 9px 3px 6px;font:700 13px ui-monospace,monospace;min-width:150px}
.ba-row.me{outline:1px solid rgba(70,224,255,.6)}
.ba-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.ba-rn{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ba-rk{font-variant-numeric:tabular-nums;opacity:.9}
#ba-feed{position:fixed;top:calc(12px + env(safe-area-inset-top));right:calc(12px + env(safe-area-inset-right));display:flex;flex-direction:column;gap:3px;align-items:flex-end;pointer-events:none}
.ba-kill{background:rgba(12,16,26,.6);border-radius:6px;padding:3px 9px;font:600 12px ui-monospace,monospace;animation:ba-in .2s}
.ba-kill b{color:#ffd24a}
.ba-kill.leader{outline:1px solid #ffd24a;color:#ffd24a}
#ba-toasts{position:fixed;top:24%;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
.ba-toast{font:800 italic 24px system-ui,sans-serif;letter-spacing:1px;text-shadow:0 2px 8px #000;animation:ba-pop .3s}
.ba-toast.leader{color:#ff5a52}
.ba-toast.delivery{color:#6bffcc}
.ba-toast.streak{color:#ffb13b}
#ba-bottom{position:fixed;bottom:calc(14px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
#ba-vitals{display:flex;flex-direction:column;gap:4px;width:340px}
.ba-bar{position:relative;height:18px;background:rgba(0,0,0,.55);border-radius:5px;overflow:hidden}
#ba-hpfill{height:100%;background:linear-gradient(90deg,#3fbf55,#62e878);transition:width .12s}
.ba-bar span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 11px ui-monospace,monospace;text-shadow:0 1px 1px #000;font-variant-numeric:tabular-nums}
#ba-abilities{display:flex;gap:8px}
.ba-abil{position:relative;width:54px;height:54px;background:rgba(18,22,34,.85);border:2px solid rgba(255,255,255,.18);border-radius:10px;overflow:hidden;box-shadow:0 3px 0 rgba(0,0,0,.4)}
.ba-abil.locked{opacity:.35}
.ba-cd{position:absolute;left:0;bottom:0;width:100%;height:0;background:rgba(10,14,24,.78)}
.ba-key{position:absolute;top:3px;left:6px;font:800 14px ui-monospace,monospace;color:#fff;text-shadow:0 1px 2px #000}
.ba-cdtext{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 16px ui-monospace,monospace;color:#fff;text-shadow:0 1px 2px #000}
#ba-items{display:flex;gap:5px;min-height:2px}
.ba-item-chip{position:relative;width:38px;height:38px;background:rgba(18,22,34,.8);border:1px solid rgba(255,255,255,.16);border-radius:7px;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ba-item-chip.active{border-color:rgba(107,255,142,.6)}
.ba-ik{position:absolute;top:1px;left:3px;font:700 9px ui-monospace,monospace;color:#9fd0ff}
.ba-in{font:700 11px ui-monospace,monospace;color:#fff}
.ba-icd{position:absolute;left:0;bottom:0;width:100%;background:rgba(10,14,24,.78);display:flex;align-items:center;justify-content:center;font:800 12px ui-monospace,monospace;color:#fff}
#ba-meta{display:flex;gap:14px;font:800 15px ui-monospace,monospace}
#ba-lvl{color:#9fd0ff}
#ba-gold{color:#ffd24a}
#ba-onboard{position:fixed;top:38%;left:50%;transform:translateX(-50%);text-align:center;font:700 19px ui-monospace,monospace;color:#fff;text-shadow:0 2px 8px #000;pointer-events:none;transition:opacity .5s;line-height:1.8;white-space:nowrap}
#ba-onboard b{color:#ffd24a}
.ba-ob-keys{font-size:13px;opacity:.7;font-weight:600}
#ba-minimap{position:fixed;right:calc(12px + env(safe-area-inset-right));bottom:calc(12px + env(safe-area-inset-bottom));width:150px;height:150px;border-radius:50%;opacity:.92;pointer-events:none}
#ba-respawn{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(40,10,10,.3),rgba(8,8,12,.7));pointer-events:none}
.ba-rtitle{font:900 italic 56px system-ui,sans-serif;color:#ff5a52;text-shadow:0 4px 0 rgba(0,0,0,.5)}
.ba-rtimer{font:800 28px ui-monospace,monospace;margin-top:8px}
#ba-shop{position:fixed;bottom:120px;left:50%;transform:translateX(-50%);width:min(92vw,560px);max-height:46vh;overflow-y:auto;background:rgba(10,14,24,.94);border:2px solid rgba(255,209,71,.4);border-radius:14px;padding:12px;pointer-events:auto;z-index:8}
.ba-shop-head{font:800 16px ui-monospace,monospace;color:#ffd24a;margin-bottom:8px}
.ba-shop-hint{font-size:11px;opacity:.6;font-weight:600}
.ba-shop-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ba-item{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:2px;background:rgba(30,36,52,.8);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 9px;color:#fff;cursor:pointer;font-family:ui-monospace,monospace}
.ba-item.afford{border-color:rgba(107,255,142,.6)}
.ba-item:disabled{opacity:.4;cursor:not-allowed}
.ba-iname{font-weight:800;font-size:13px}
.ba-idesc{font-size:10px;opacity:.7}
.ba-icost{font-size:12px;color:#ffd24a;font-weight:700}
#ba-end{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(20,16,28,.4),rgba(8,8,14,.85));z-index:20}
.ba-end-card{text-align:center;pointer-events:auto}
.ba-end-title{font:900 italic 90px system-ui,sans-serif;letter-spacing:-2px;text-shadow:0 6px 0 rgba(0,0,0,.5)}
.ba-end-sub{font:600 18px ui-monospace,monospace;margin-top:8px;opacity:.9}
.ba-end-btn{margin-top:26px;font:800 16px ui-monospace,monospace;letter-spacing:2px;color:#14111a;background:#ffd24a;border:none;border-radius:10px;padding:14px 26px;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.4)}
@keyframes ba-in{from{opacity:0;transform:translateX(12px)}}
@keyframes ba-pop{from{opacity:0;transform:scale(.7)}}
@media(max-width:720px){#ba-board{display:none}#ba-minimap{display:none}.ba-abil{width:46px;height:46px}#ba-vitals{width:240px}}
`;

// keep ItemDef referenced for tooling
export type { ItemDef };

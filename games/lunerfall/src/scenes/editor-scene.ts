import Phaser from "phaser";

import { BASE_H, BASE_W, COLORS, ENEMY_ORIGIN_Y, HERO_ORIGIN_Y } from "../config";
import {
  type ClipInfo,
  clipsFor,
  type EnemyName,
  ENEMY_NAMES,
  firstFrame,
  type HeroName,
  HERO_NAMES,
} from "../data/animations";
import { HEROES } from "../data/heroes";
import { clipGameMs } from "../entities/player";

// ?editor=1 — an animation viewer / debug page, styled after the Battle Arena
// editor: a DOM chrome (top bar + character roster + clip list) over a big stage
// that plays ONE clip large enough to actually read the frames + the attack's
// hitbox reach. LEFT/RIGHT (or click) switch character; UP/DOWN (or click) switch
// clip. ?char=riven deep-links a character.

type Char = { key: HeroName; hero: true } | { key: EnemyName; hero: false };
const CHARS: Char[] = [
  ...HERO_NAMES.map((key): Char => ({ key, hero: true })),
  ...ENEMY_NAMES.map((key): Char => ({ key, hero: false })),
];

const STAGE_X = BASE_W / 2;
const GROUND_Y = 214;
const HERO_SCALE_ED = 3.9;
const ENEMY_SCALE_ED = 5.8;

// The in-game control that triggers each clip (heroes only — enemies are AI).
// Swing clips fire on Attack (J), the special on K; the rest map to movement.
function hotkeyFor(char: Char, clip: string): string {
  if (!char.hero) return "";
  const kit = HEROES[char.key].kit;
  if (kit.swings.some((s) => s.clip === clip)) return "J";
  const sp = kit.special;
  if (sp.clip === clip || ("outClip" in sp && sp.outClip === clip)) return "K";
  switch (clip) {
    case "run":
      return "← →";
    case "jump":
      return "↑ / Spc";
    case "dash":
      return "⇧ / L";
    default:
      return ""; // idle / fall / hurt / death / idle-break — contextual, no key
  }
}

export class EditorScene extends Phaser.Scene {
  private ci = 0;
  private clipI = 0;
  private clips: ClipInfo[] = [];
  private sprite?: Phaser.GameObjects.Sprite;
  private fxLayer?: Phaser.GameObjects.Graphics;
  private shadow?: Phaser.GameObjects.Ellipse;
  private ui?: HTMLDivElement;

  constructor() {
    super("editor");
  }

  create() {
    // Stage: blue-grey backdrop + a ground line the character stands on.
    this.add.rectangle(0, 0, BASE_W, BASE_H, 0x475066).setOrigin(0);
    this.add.rectangle(0, BASE_H * 0.5, BASE_W, BASE_H * 0.5, 0x2b3242).setOrigin(0);
    this.add.rectangle(0, GROUND_Y, BASE_W, 2, COLORS.teal, 0.35).setOrigin(0, 0.5).setDepth(1);
    this.shadow = this.add.ellipse(STAGE_X, GROUND_Y + 2, 76, 16, COLORS.ink, 0.4).setDepth(2);
    this.fxLayer = this.add.graphics().setDepth(4);

    const kb = this.input.keyboard;
    kb?.on("keydown-LEFT", () => this.cycleChar(-1));
    kb?.on("keydown-A", () => this.cycleChar(-1));
    kb?.on("keydown-RIGHT", () => this.cycleChar(1));
    kb?.on("keydown-D", () => this.cycleChar(1));
    kb?.on("keydown-UP", () => this.selectClip(this.clipI - 1));
    kb?.on("keydown-DOWN", () => this.selectClip(this.clipI + 1));
    // The actual game action keys jump to + play the matching clip, so you can
    // press J / K / L and watch what they fire (movement keys stay editor-nav).
    kb?.on("keydown-J", () => this.playHotkey("J"));
    kb?.on("keydown-K", () => this.playHotkey("K"));
    kb?.on("keydown-L", () => this.playHotkey("⇧ / L"));

    const want = new URLSearchParams(location.search).get("char");
    const at = want ? CHARS.findIndex((c) => c.key === want) : -1;
    if (at >= 0) this.ci = at;

    this.buildUI();
    this.selectChar(this.ci);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.ui?.remove();
      this.ui = undefined;
    });
  }

  private cycleChar(d: number) {
    this.selectChar((this.ci + d + CHARS.length) % CHARS.length);
  }

  // Play the first clip triggered by the given in-game key (J / K / dash).
  private playHotkey(key: string) {
    const char = CHARS[this.ci];
    if (!char) return;
    const idx = this.clips.findIndex((c) => hotkeyFor(char, c.clip) === key);
    if (idx >= 0) this.selectClip(idx);
  }

  // Switch character: rebuild the big sprite (new texture/origin/scale), refill
  // the clip list, and play the first clip.
  private selectChar(i: number) {
    this.ci = i;
    const char = CHARS[i];
    if (!char) return;
    this.clips = clipsFor(this, char.key);
    this.sprite?.destroy();
    const originY = char.hero ? HERO_ORIGIN_Y : ENEMY_ORIGIN_Y;
    this.sprite = this.add
      .sprite(STAGE_X, GROUND_Y, char.key, firstFrame(this, char.key))
      .setOrigin(0.5, originY)
      .setScale(char.hero ? HERO_SCALE_ED : ENEMY_SCALE_ED)
      .setDepth(5);
    this.fillClipList();
    this.highlightRoster();
    this.selectClip(0);
  }

  private selectClip(i: number) {
    if (this.clips.length === 0) return;
    this.clipI = (i + this.clips.length) % this.clips.length;
    const info = this.clips[this.clipI];
    const char = CHARS[this.ci];
    if (!info || !char || !this.sprite) return;
    const hero = char.hero ? HEROES[char.key] : undefined;
    this.sprite.play({ key: `${char.key}:${info.clip}`, repeat: -1 });
    // timeScale (not duration) re-times without freezing per-frame-duration anims.
    const gm = hero ? clipGameMs(hero, info.clip) : undefined;
    const authored = this.sprite.anims.currentAnim?.duration ?? 0;
    this.sprite.anims.timeScale = gm !== undefined && gm > 0 && authored > 0 ? authored / gm : 1;
    this.drawFx(char, info.clip);
    this.updateStatus(info, gm);
    this.highlightClip();
  }

  // Overlay the attack's live hitbox: swings draw their forward reach box, an AOE
  // special draws its radius. This is what "the effects" refers to — where a move
  // actually connects — now legible at stage scale.
  private drawFx(char: Char, clip: string) {
    const g = this.fxLayer;
    if (!g) return;
    g.clear();
    if (!char.hero) return;
    const kit = HEROES[char.key].kit;
    // Reach/radius are game-space px; scale them by the stage zoom so the hitbox
    // lines up with the enlarged character.
    const sw = kit.swings.find((s) => s.clip === clip);
    if (sw) {
      const w = sw.reach * HERO_SCALE_ED;
      const y0 = GROUND_Y - 120;
      g.fillStyle(COLORS.teal, 0.12).fillRect(STAGE_X + 12, y0, w, 84);
      g.lineStyle(1, COLORS.teal, 0.6).strokeRect(STAGE_X + 12, y0, w, 84);
    }
    const sp = kit.special;
    if (sp.clip === clip && sp.kind === "aoe") {
      const r = sp.radius * HERO_SCALE_ED;
      g.fillStyle(COLORS.magenta, 0.1).fillCircle(STAGE_X, GROUND_Y - 60, r);
      g.lineStyle(1, COLORS.magenta, 0.6).strokeCircle(STAGE_X, GROUND_Y - 60, r);
    }
  }

  // ── DOM chrome ───────────────────────────────────────────────────────────────

  private buildUI() {
    injectStyle();
    const ui = document.createElement("div");
    ui.id = "lf-editor";
    const roster = CHARS.map((c, i) => {
      const dot = c.hero
        ? `#${HEROES[c.key].color.toString(16).padStart(6, "0")}`
        : "#8b95a1";
      const tag = c.hero ? "" : `<em>foe</em>`;
      return `<button class="lf-char" data-i="${i}"><i style="background:${dot}"></i><span>${c.key}</span>${tag}</button>`;
    }).join("");
    ui.innerHTML = `
      <div class="lf-top">
        <span class="lf-logo">LUNERFALL</span>
        <span class="lf-sub">ANIMATION VIEWER</span>
        <span class="lf-status" id="lf-status"></span>
      </div>
      <div class="lf-panel lf-roster">
        <div class="lf-h">CHARACTERS</div>
        <div class="lf-scroll">${roster}</div>
      </div>
      <div class="lf-panel lf-clips">
        <div class="lf-h">CLIPS</div>
        <div class="lf-scroll" id="lf-cliplist"></div>
      </div>
      <div class="lf-help">← → character&nbsp;&nbsp;·&nbsp;&nbsp;↑ ↓ clip&nbsp;&nbsp;·&nbsp;&nbsp;badge = in-game key&nbsp;&nbsp;·&nbsp;&nbsp;J / K / L fire attack / special / dash</div>`;
    document.body.appendChild(ui);
    this.ui = ui;
    ui.querySelectorAll<HTMLButtonElement>(".lf-char").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number.parseInt(btn.dataset["i"] ?? "", 10);
        if (Number.isFinite(i)) this.selectChar(i);
      });
    });
  }

  private fillClipList() {
    const list = document.getElementById("lf-cliplist");
    if (!list) return;
    const char = CHARS[this.ci];
    list.innerHTML = this.clips
      .map((info, i) => {
        const warn = info.frames <= 1 ? ' <b class="lf-warn">⚠1f</b>' : "";
        const key = char ? hotkeyFor(char, info.clip) : "";
        const badge = key ? `<kbd>${key}</kbd>` : "";
        return `<button class="lf-clip" data-i="${i}"><div class="lf-clip-row"><span>${info.clip}</span>${badge}</div><em>${info.frames}f · ${info.ms}ms${warn}</em></button>`;
      })
      .join("");
    list.querySelectorAll<HTMLButtonElement>(".lf-clip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number.parseInt(btn.dataset["i"] ?? "", 10);
        if (Number.isFinite(i)) this.selectClip(i);
      });
    });
  }

  private highlightRoster() {
    this.ui?.querySelectorAll<HTMLButtonElement>(".lf-char").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset["i"] === String(this.ci));
    });
  }

  private highlightClip() {
    const active = this.ui?.querySelector(`.lf-clip[data-i="${this.clipI}"]`);
    this.ui?.querySelectorAll<HTMLButtonElement>(".lf-clip").forEach((btn) => {
      btn.classList.toggle("on", btn === active);
    });
    if (active instanceof HTMLElement) active.scrollIntoView({ block: "nearest" });
  }

  private updateStatus(info: ClipInfo, gameMs: number | undefined) {
    const el = document.getElementById("lf-status");
    if (!el) return;
    const char = CHARS[this.ci];
    const timing =
      gameMs !== undefined && gameMs !== info.ms ? `${info.ms}→${gameMs}ms` : `${info.ms}ms`;
    el.textContent = `${char?.key ?? ""}  ·  ${info.clip}  ·  ${info.frames}f  ·  ${timing}`;
  }
}

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = `
#lf-editor{position:fixed;inset:0;z-index:40;pointer-events:none;font-family:ui-monospace,"Courier New",monospace;color:#f4f7fb}
#lf-editor button{pointer-events:auto;cursor:pointer;font:600 11px ui-monospace,monospace;color:#c7d0db;background:rgba(20,26,42,.85);border:1px solid rgba(255,255,255,.14);border-radius:7px;padding:6px 9px}
#lf-editor button:hover{border-color:#34e5c8;color:#34e5c8}
#lf-editor .on{border-color:#34e5c8;color:#34e5c8;background:rgba(20,54,54,.9)}
.lf-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:10px;padding:9px 14px;background:linear-gradient(#05070bee,#05070b00)}
.lf-logo{font:900 italic 18px system-ui,sans-serif;letter-spacing:-1px;color:#34e5c8}
.lf-sub{font:800 10px ui-monospace,monospace;letter-spacing:2px;opacity:.55}
.lf-status{font:600 11px ui-monospace,monospace;color:#ffd15c;margin-left:auto}
.lf-panel{position:absolute;top:48px;bottom:42px;display:flex;flex-direction:column;gap:6px;background:rgba(8,10,18,.82);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px;pointer-events:auto}
.lf-roster{left:12px;width:150px}
.lf-clips{right:12px;width:186px}
.lf-h{font:800 10px ui-monospace,monospace;letter-spacing:1.5px;opacity:.5;padding:2px 2px 4px}
.lf-scroll{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;min-height:0}
#lf-editor .lf-char{display:flex;align-items:center;gap:8px;text-align:left}
#lf-editor .lf-char i{width:12px;height:12px;border-radius:50%;flex:none;box-shadow:0 0 6px currentColor}
#lf-editor .lf-char span{flex:1;text-transform:capitalize}
#lf-editor .lf-char em{font:700 8px ui-monospace,monospace;opacity:.5;font-style:normal;letter-spacing:1px}
#lf-editor .lf-clip{display:flex;flex-direction:column;align-items:stretch;gap:2px;text-align:left}
.lf-clip-row{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%}
#lf-editor .lf-clip span{font-weight:700}
#lf-editor .lf-clip kbd{flex:none;font:800 9px ui-monospace,monospace;color:#ffd15c;background:rgba(255,209,92,.12);border:1px solid rgba(255,209,92,.5);border-radius:4px;padding:1px 5px;box-shadow:0 1px 0 rgba(255,209,92,.25)}
#lf-editor .lf-clip em{font:600 9px ui-monospace,monospace;opacity:.6;font-style:normal}
#lf-editor .lf-warn{color:#ff8a5c}
.lf-help{position:absolute;left:0;right:0;bottom:0;text-align:center;padding:9px;font:600 10px ui-monospace,monospace;opacity:.55;background:linear-gradient(#05070b00,#05070bdd)}
`;
  document.head.appendChild(s);
}

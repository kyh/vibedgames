import * as THREE from "three";

// Cute comic speech bubbles that float above cars: player chat, remote
// players' chat, and NPC heckling. Each bubble is a canvas-drawn sprite
// (rounded rect + tail), billboarded by THREE.Sprite, popping in and fading
// out. One canvas/texture per ACTIVE bubble — a handful at most.

type Bubble = {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
  anchor: THREE.Object3D | (() => THREE.Vector3 | null);
  lift: number;
  age: number;
  dur: number;
};

const MAX_BUBBLES = 10;
const FONT = "700 26px system-ui, -apple-system, sans-serif";
const PAD_X = 18;
const PAD_Y = 12;
const TAIL_H = 16;
const RADIUS = 14;
const MAX_LINE_W = 340;

function drawBubble(text: string, accent: string): HTMLCanvasElement {
  const measure = document.createElement("canvas").getContext("2d");
  const lines: string[] = [];
  if (measure) {
    measure.font = FONT;
    let line = "";
    for (const word of text.split(/\s+/)) {
      const probe = line ? `${line} ${word}` : word;
      if (measure.measureText(probe).width > MAX_LINE_W && line) {
        lines.push(line);
        line = word;
      } else {
        line = probe;
      }
    }
    if (line) lines.push(line);
  } else {
    lines.push(text);
  }
  const lineH = 32;
  const textW = measure
    ? Math.max(...lines.map((l) => measure.measureText(l).width), 40)
    : MAX_LINE_W;
  const w = Math.ceil(textW + PAD_X * 2);
  const h = lines.length * lineH + PAD_Y * 2;
  const canvas = document.createElement("canvas");
  canvas.width = w + 8;
  canvas.height = h + TAIL_H + 8;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const x = 4;
  const y = 4;
  // bubble body
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, RADIUS);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.fill();
  ctx.stroke();
  // tail (bottom centre)
  const cx = x + w / 2;
  ctx.beginPath();
  ctx.moveTo(cx - 12, y + h - 2);
  ctx.lineTo(cx + 12, y + h - 2);
  ctx.lineTo(cx, y + h + TAIL_H);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - 12, y + h - 1);
  ctx.lineTo(cx, y + h + TAIL_H);
  ctx.lineTo(cx + 12, y + h - 1);
  ctx.stroke();
  // erase the stroke line between body and tail
  ctx.fillRect(cx - 10, y + h - 4, 20, 5);
  // text
  ctx.font = FONT;
  ctx.fillStyle = "#1c2030";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((l, i) => {
    ctx.fillText(l, x + w / 2, y + PAD_Y + lineH * (i + 0.5));
  });
  return canvas;
}

export class SpeechBubbles {
  readonly group = new THREE.Group();
  private bubbles: Bubble[] = [];

  // Show a bubble above `anchor` (an object, or a fn returning a world pos —
  // return null to hide early). One bubble per anchor: a new say() replaces.
  say(
    anchor: THREE.Object3D | (() => THREE.Vector3 | null),
    text: string,
    opts?: { dur?: number; lift?: number; accent?: string },
  ): void {
    const clean = text.trim().slice(0, 90);
    if (!clean) return;
    this.dismiss(anchor);
    while (this.bubbles.length >= MAX_BUBBLES) {
      const oldest = this.bubbles.shift();
      if (oldest) this.dispose(oldest);
    }
    const canvas = drawBubble(clean, opts?.accent ?? "#1c2030");
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    // world size: ~0.02 units per canvas px reads well over a car
    sprite.scale.set(canvas.width * 0.02, canvas.height * 0.02, 1);
    sprite.renderOrder = 50;
    this.group.add(sprite);
    this.bubbles.push({
      sprite,
      texture,
      anchor,
      lift: opts?.lift ?? 3.2,
      age: 0,
      dur: opts?.dur ?? 6,
    });
  }

  dismiss(anchor: THREE.Object3D | (() => THREE.Vector3 | null)): void {
    const i = this.bubbles.findIndex((b) => b.anchor === anchor);
    if (i >= 0) {
      const b = this.bubbles[i];
      if (b) this.dispose(b);
      this.bubbles.splice(i, 1);
    }
  }

  update(dt: number): void {
    const pos = new THREE.Vector3();
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      if (!b) continue;
      b.age += dt;
      let anchored = false;
      if (typeof b.anchor === "function") {
        const p = b.anchor();
        if (p) {
          pos.copy(p);
          anchored = true;
        }
      } else if (b.anchor.parent) {
        b.anchor.getWorldPosition(pos);
        anchored = true;
      }
      if (!anchored || b.age >= b.dur) {
        this.dispose(b);
        this.bubbles.splice(i, 1);
        continue;
      }
      // pop in, gentle idle bob, fade out at the end
      const popIn = Math.min(1, b.age / 0.18);
      const fade = Math.min(1, (b.dur - b.age) / 0.5);
      const bob = Math.sin(b.age * 2.2) * 0.08;
      b.sprite.position.set(pos.x, pos.y + b.lift + bob + (1 - popIn) * -0.4, pos.z);
      const s = 0.7 + 0.3 * popIn;
      const canvas = b.texture.image;
      const cw = canvas instanceof HTMLCanvasElement ? canvas.width : 200;
      const ch = canvas instanceof HTMLCanvasElement ? canvas.height : 80;
      b.sprite.scale.set(cw * 0.02 * s, ch * 0.02 * s, 1);
      if (b.sprite.material instanceof THREE.SpriteMaterial) {
        b.sprite.material.opacity = popIn * fade;
      }
    }
  }

  private dispose(b: Bubble): void {
    this.group.remove(b.sprite);
    b.texture.dispose();
    if (b.sprite.material instanceof THREE.SpriteMaterial) b.sprite.material.dispose();
  }
}

// --- NPC heckling: what SF has actually said/done to robotaxis, playfully ---
// (coning protests, the 50-Waymo dead-end prank, backflips off roofs,
// "there's no driver?!", holiday gridlock screaming — see project notes)
export const HECKLES: readonly string[] = [
  "THERE'S NO DRIVER?!",
  "Somebody get a cone!",
  "Cone this thing!!",
  "Hey! Watch it, toaster!",
  "Who do I even honk at?!",
  "Not the Waymo standoff again",
  "Learn to drive, algorithm!",
  "Do a backflip!",
  "You good, robot?",
  "Beep beep to you too, buddy",
  "My insurance says WHAT",
  "I'm reporting you to the DMV… and the App Store",
  "Pull over! …wait, who am I talking to",
  "Where's your supervisor? The cloud?!",
  "One star. ONE STAR.",
  "It's driving itself?! In THIS economy?",
  "Watch the paint, Siri!",
  "Did a spreadsheet just cut me off?",
  "Fifty of you blocked my street last week!",
  "Go back to Phoenix!",
  "Eyes on the road, chatbot!",
  "It beeped at me. IT BEEPED AT ME.",
  "You brake for pigeons but not for ME?",
  "My grandma drives better and she's 90",
  "Tell your engineers I said hi",
  "Is this thing recording? Hi mom!",
  "Unplug it! UNPLUG IT!",
  "I've seen Roombas with better lane discipline",
  "This is why we cone them",
  "Empty?! I got yelled at by an EMPTY CAR?!",
];

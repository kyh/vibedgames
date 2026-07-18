import Phaser from "phaser";

import { FONT } from "../render/font";
import { startGallery, startShowcase } from "./dev-scenes";
import type { GallerySection } from "./dev-scenes";

// A shared row of clickable tabs across the top of every gallery page, so hopping
// between them is one click instead of a URL edit. "UI" is the character/bot
// showcase (ShowcaseScene, ?viewer); the rest are asset pages (GalleryScene
// sections, ?gallery=<section>).

type TabId = "viewer" | GallerySection;

const TABS: { id: TabId; label: string }[] = [
  { id: "viewer", label: "UI" },
  { id: "units", label: "Units" },
  { id: "terrain", label: "Terrain" },
  { id: "fx", label: "FX" },
  { id: "map", label: "Map" },
];

const TAB_W = 100;
const GAP = 8;

export function buildGalleryNav(scene: Phaser.Scene, current: string, y = 26): void {
  const go = (id: TabId): void => {
    if (id === current) return;
    // keep the address bar on the route scheme so any page is shareable/refreshable
    window.history.replaceState(null, "", id === "viewer" ? "?viewer" : `?gallery=${id}`);
    if (id === "viewer") void startShowcase(scene);
    else void startGallery(scene, id);
  };

  const total = TABS.length * TAB_W + (TABS.length - 1) * GAP;
  let x = scene.scale.width / 2 - total / 2;
  for (const t of TABS) {
    const active = t.id === current;
    const box = scene.add
      .rectangle(x, y, TAB_W, 30, active ? 0x2b5c57 : 0x16302e, 0.95)
      .setOrigin(0, 0.5)
      .setStrokeStyle(2, active ? 0xffe14a : 0x3f6f69)
      .setScrollFactor(0)
      .setDepth(5000)
      .setInteractive({ useHandCursor: true });
    scene.add
      .text(x + TAB_W / 2, y, t.label, {
        fontFamily: FONT,
        fontSize: "14px",
        color: active ? "#fff3c4" : "#cfeae6",
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(5001);
    if (!active) {
      box.on("pointerover", () => box.setFillStyle(0x1f4641, 1));
      box.on("pointerout", () => box.setFillStyle(0x16302e, 0.95));
    }
    box.on("pointerdown", () => go(t.id));
    x += TAB_W + GAP;
  }
}

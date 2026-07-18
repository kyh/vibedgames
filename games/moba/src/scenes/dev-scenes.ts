import type Phaser from "phaser";

// Lazy loaders for the dev surfaces: the ?viewer character showcase and the
// ?gallery asset pages. Each scene class is dynamic-imported the first time its
// route (BootScene) or nav tab (gallery-nav) needs it, so no surface code lands
// in the main game chunk. `scene.add` is deduped (re-checked after the await)
// because Phaser 4 keeps scene instances registered across start/stop.

export const GALLERY_SECTIONS = ["units", "terrain", "fx", "map"] as const;
export type GallerySection = (typeof GALLERY_SECTIONS)[number];

/** Map a raw ?gallery value to a valid section (default: units). */
export function gallerySection(raw: string | null): GallerySection {
  return GALLERY_SECTIONS.find((s) => s === raw) ?? "units";
}

async function ensureScene(
  game: Phaser.Game,
  key: string,
  load: () => Promise<Phaser.Types.Scenes.SceneType>,
): Promise<void> {
  if (game.scene.getScene(key)) return;
  const scene = await load();
  if (!game.scene.getScene(key)) game.scene.add(key, scene);
}

/** Lazy-add + start the character/bot showcase (?viewer). */
export async function startShowcase(from: Phaser.Scene): Promise<void> {
  await ensureScene(
    from.game,
    "Showcase",
    async () => (await import("./showcase-scene")).ShowcaseScene,
  );
  from.scene.start("Showcase");
}

/** Lazy-add + start an asset gallery page (?gallery=<section>). */
export async function startGallery(from: Phaser.Scene, section: GallerySection): Promise<void> {
  await ensureScene(
    from.game,
    "Gallery",
    async () => (await import("./gallery-scene")).GalleryScene,
  );
  from.scene.start("Gallery", { section });
}

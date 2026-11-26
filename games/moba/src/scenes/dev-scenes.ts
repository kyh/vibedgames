import type Phaser from "phaser";

export const GALLERY_SECTIONS = ["units", "terrain", "fx", "map"] as const;

export type GallerySection = (typeof GALLERY_SECTIONS)[number];

/** Map a raw ?gallery value to a valid section (default: units). */
export const gallerySection: (raw: string | null) => GallerySection = (raw) =>
  GALLERY_SECTIONS.find((s) => s === raw) ?? "units";

const ensureScene = async (
  game: Phaser.Game,
  key: string,
  load: () => Promise<Phaser.Types.Scenes.SceneType>,
) => {
  const loaded: Phaser.Scene | null = game.scene.getScene(key);

  if (loaded !== null) {
    return;
  }

  const scene = await load();
  const raced: Phaser.Scene | null = game.scene.getScene(key);

  if (raced === null) {
    game.scene.add(key, scene);
  }
};

/** Lazy-add + start the character/bot showcase (?viewer). */
export const startShowcase = async (from: Phaser.Scene) => {
  await ensureScene(from.game, "Showcase", async () => {
    const { ShowcaseScene } = await import("./showcase-scene");

    return ShowcaseScene;
  });
  from.scene.start("Showcase");
};

/** Lazy-add + start an asset gallery page (?gallery=<section>). */
export const startGallery = async (from: Phaser.Scene, section: GallerySection) => {
  await ensureScene(from.game, "Gallery", async () => {
    const { GalleryScene } = await import("./gallery-scene");

    return GalleryScene;
  });
  from.scene.start("Gallery", { section });
};

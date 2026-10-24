/**
 * The social-preview media committed under `public/`: the site-wide gameplay
 * montage behind `og:video`, and one Open Graph card per prose page.
 *
 * Every file named here is captured, not drawn by hand or generated: the
 * montage is the bundled example games' own `?trailer=1` runs, recorded and
 * cut by `apps/web/scripts/og-video.mjs` (`pnpm og:video`), and the cards are
 * rendered from the pages' own titles by the same script. Re-run it after a
 * page title or a game's trailer changes; `test/og-media.test.ts` holds every
 * path here to a file that exists.
 */

export const siteVideo = {
  description:
    "Gameplay from three of the example games that ship with Vibedgames — Starfall, Battle Arena and Lunerfall — recorded from their own scripted trailer runs.",
  /** ISO 8601, and what the montage really runs: the script cuts it to this. */
  duration: "PT8S",
  height: 630,
  name: "Vibedgames gameplay montage",
  path: "/og/og.mp4",
  /** The montage's first frame, for `VideoObject.thumbnailUrl`. */
  poster: "/og/og-poster.jpg",
  type: "video/mp4",
  /** The day the committed montage was captured. */
  uploadDate: "2026-10-24",
  width: 1200,
} as const;

/** The site-wide Open Graph image, shared by `/` and every non-prose page. */
export const SITE_IMAGE = "/og.jpg";

/** Prose pages that carry a card of their own, rendered by `pnpm og:video`. */
export const PAGE_CARD_PATHS = [
  "/discover",
  "/build",
  "/docs",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
] as const;

const hasCard = (path: string) => PAGE_CARD_PATHS.some((cardPath) => cardPath === path);

/** The Open Graph image for a site path: its own card, else the site image. */
export const pageImage = (path: string) => (hasCard(path) ? `/og/pages${path}.jpg` : SITE_IMAGE);

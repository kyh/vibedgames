/**
 * The social-preview media committed under `public/`: the site-wide trailer
 * behind `og:video`, and one Open Graph card per prose page.
 *
 * Every file named here is recorded, not drawn by hand or generated: the
 * trailer is `apps/web/scripts/og-scene.html` (a dimensional drawing of the
 * mark and its tagline, with six game genres measured around it) stepped frame by frame and encoded by
 * `apps/web/scripts/og-video.ts` (`pnpm -F @repo/web og:video`), and the
 * cards are rendered from the pages' own titles by the same script. Re-run it after a
 * page title or the scene changes; `test/og-media.test.ts` holds every
 * path here to a file that exists.
 */

export const siteVideo = {
  description:
    "A dimensional drawing of the Vibedgames mark over its tagline, A game studio for your agent: the pen measures the logo, then draws six kinds of game around it as dimensioned wireframes — a platformer, a bomberman grid, a paddle court, a top-down shooter, a 3D arena in isometric and a falling-block well — and lifts the platformer's background, tiles, sprites and HUD apart into an exploded view.",
  /** ISO 8601, and what the scene really runs: the script checks it against this. */
  duration: "PT10S",
  height: 630,
  name: "Vibedgames dimensional drawing",
  path: "/og/og.mp4",
  /** The full-sheet frame, for `VideoObject.thumbnailUrl`. */
  poster: "/og/og-poster.jpg",
  type: "video/mp4",
  /** The day the committed trailer was recorded. */
  uploadDate: "2026-10-25",
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

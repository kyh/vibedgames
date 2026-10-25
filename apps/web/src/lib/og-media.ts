/**
 * The social-preview media committed under `public/`: the site-wide trailer
 * behind `og:video`, and one Open Graph card per prose page.
 *
 * Every file named here is recorded, not drawn by hand or generated: the
 * trailer is `apps/web/scripts/og-scene.html` (one continuous wireframe shot:
 * a hero travelling through five games that re-form into one another, ending
 * on the icon and its tagline) stepped frame by frame and encoded by
 * `apps/web/scripts/og-video.ts` (`pnpm -F @repo/web og:video`); the same
 * scene draws the site image and poster, and the same script renders the
 * cards from the pages' own titles. Re-run it after a
 * page title or the scene changes; `test/og-media.test.ts` holds every
 * path here to a file that exists.
 */

export const siteVideo = {
  description:
    "One continuous wireframe shot: the Vibedgames icon folds into a little hero who hops up a platformer's ledges, drops into a bomberman grid the tiles slide into, becomes the ball of a paddle court the walls stretch into, runs as a cube through the 3D arena the court tilts into, and falls as the last block into a falling-block well, before every game collapses back into the icon over its tagline, A game studio for your agent.",
  /** ISO 8601, and what the scene really runs: the script checks it against this. */
  duration: "PT10S",
  height: 630,
  name: "Vibedgames: one hero, every game",
  path: "/og/og.mp4",
  /** The site image's still (icon and tagline over the arena), for `VideoObject.thumbnailUrl`. */
  poster: "/og/og-poster.jpg",
  type: "video/mp4",
  /** The day the committed trailer was recorded. */
  uploadDate: "2026-10-25",
  width: 1200,
} as const;

/**
 * The site-wide Open Graph image, shared by `/` and every non-prose page: the
 * trailer's icon and tagline over its 3D arena, drawn by the same scene.
 */
export const SITE_IMAGE = "/og.jpg";

/** What the site image shows, for `og:image:alt` and `twitter:image:alt`. */
export const SITE_IMAGE_ALT =
  "The Vibedgames icon over its tagline, A game studio for your agent, above a wireframe 3D arena where a little hero cube runs between towers.";

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

/** The alt text for a site path's Open Graph image: a card shows the page's title. */
export const pageImageAlt = (path: string, title: string) =>
  hasCard(path) ? title : SITE_IMAGE_ALT;

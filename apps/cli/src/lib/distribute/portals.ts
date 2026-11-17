/**
 * Web portals that take a game as a zip, and the rules each one publishes.
 *
 * A limit is here only when the portal's own documentation states it; `null`
 * means the portal names none, not that there is none. Every portal frames the
 * game on its own origin and unpacks it under a path of its choosing, which is
 * what `auditBuild` checks whatever the portal.
 */

const MB = 1024 * 1024;

export interface PortalLimits {
  maxZipBytes: number | null;
  maxExtractedBytes: number | null;
  maxFiles: number | null;
  maxFileBytes: number | null;
  maxPathLength: number | null;
  /** What every path segment must match, when the portal restricts file names. */
  fileName: RegExp | null;
  /** `restricted`: the portal blocks or reviews requests to hosts other than its own. */
  network: "open" | "restricted";
}

/**
 * A portal SDK the game must call, and that vibedgames adds to the package
 * rather than to the game: it is a script from the portal's own host, which
 * has no business loading for a player anywhere else.
 */
export interface PortalSdk {
  /** Loaded by a tag ahead of every other script in the packaged index.html. */
  script: string;
  /** Calls the build must make; their absence fails the package. */
  calls: string[];
  /** The Content-Security-Policy the portal serves the game under. */
  csp: string;
  /** What `--preview` serves in place of `script`. */
  stub: "ytgame";
}

export interface Portal {
  id: string;
  name: string;
  /** Where a person uploads the zip, when the portal has a public form. */
  submitUrl: string | null;
  /** `open`: anyone uploads and it is live. `review`: the portal's staff decide. */
  access: "open" | "review";
  /** Whether the portal's own SDK must be built into the game before it is accepted. */
  sdk: "none" | "required";
  /** The SDK this command can wire and check, when the portal has one it knows. */
  integration: PortalSdk | null;
  limits: PortalLimits;
  /** What an agent must know before choosing this portal, in one line. */
  notes: string;
}

const UNLIMITED: PortalLimits = {
  fileName: null,
  maxExtractedBytes: null,
  maxFileBytes: null,
  maxFiles: null,
  maxPathLength: null,
  maxZipBytes: null,
  network: "open",
};

// Verbatim from YouTube's test suite guide, which says production serves the
// game under it.
const YOUTUBE_CSP =
  "default-src 'none'; script-src 'report-sample' 'self' 'unsafe-eval' 'unsafe-inline' blob: " +
  "https://www.youtube.com/game_api/v0 https://www.youtube.com/game_api/v0/ " +
  "https://www.youtube.com/game_api/v1 https://www.youtube.com/game_api/v1/; " +
  "object-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' blob: data:; media-src 'self' blob:; " +
  "font-src 'self' data: https://fonts.googleapis.com https://fonts.gstatic.com; " +
  "connect-src 'self' blob: data:; sandbox allow-pointer-lock allow-same-origin allow-scripts; " +
  "base-uri 'self'; manifest-src 'self'; worker-src 'self' blob:";

export const PORTALS: Portal[] = [
  {
    access: "open",
    id: "web",
    integration: null,
    limits: UNLIMITED,
    name: "Any web host",
    notes: "No portal's limits: only the checks every folder-hosted, framed game must pass.",
    sdk: "none",
    submitUrl: null,
  },
  {
    access: "open",
    id: "itch",
    integration: null,
    limits: {
      ...UNLIMITED,
      maxExtractedBytes: 500 * MB,
      maxFileBytes: 200 * MB,
      maxFiles: 1000,
      maxPathLength: 240,
    },
    name: "itch.io",
    notes:
      "Live on upload. Set the upload's kind to HTML and give the embed a viewport size. `butler push` uploads from a shell.",
    sdk: "none",
    submitUrl: "https://itch.io/game/new",
  },
  {
    access: "open",
    id: "newgrounds",
    integration: null,
    limits: UNLIMITED,
    name: "Newgrounds",
    notes:
      "Live on upload, then players vote on whether it stays. Two submissions a day; the size cap is per account.",
    sdk: "none",
    submitUrl: "https://www.newgrounds.com/projects/games",
  },
  {
    access: "review",
    id: "crazygames",
    integration: null,
    limits: { ...UNLIMITED, maxExtractedBytes: 250 * MB, maxFiles: 1500 },
    name: "CrazyGames",
    notes:
      "Reviewed before it is listed. Without their SDK the whole build must be under 50 MB, and the first playable moment under 20 seconds.",
    sdk: "none",
    submitUrl: "https://developer.crazygames.com",
  },
  {
    access: "review",
    id: "poki",
    integration: null,
    limits: { ...UNLIMITED, network: "restricted" },
    name: "Poki",
    notes:
      "Curated, and exclusive on the web: a game listed there may not be on other portals. Their SDK is required, and every other host (a multiplayer server too) is blocked until they approve it.",
    sdk: "required",
    submitUrl: "https://developers.poki.com",
  },
  {
    access: "review",
    id: "gamedistribution",
    integration: null,
    limits: UNLIMITED,
    name: "GameDistribution",
    notes: "Reviewed, and their SDK is required in every game.",
    sdk: "required",
    submitUrl: "https://gamedistribution.com/developers",
  },
  {
    access: "review",
    id: "youtube",
    integration: {
      calls: ["firstFrameReady", "gameReady", "onPause", "onResume", "isAudioEnabled"],
      csp: YOUTUBE_CSP,
      script: "https://www.youtube.com/game_api/v1",
      stub: "ytgame",
    },
    limits: {
      fileName: /^[A-Za-z0-9_.-]+$/u,
      maxExtractedBytes: 250 * MB,
      maxFileBytes: 30 * MB,
      maxFiles: 8000,
      maxPathLength: null,
      maxZipBytes: null,
      network: "restricted",
    },
    name: "YouTube Playables",
    notes:
      "Invite-only early access: a channel YouTube has onboarded uploads through the Playables portal. The game must call YouTube's SDK, play sound only when YouTube allows, and reach no other host.",
    sdk: "required",
    submitUrl: "https://www.youtube.com/playables_portal",
  },
];

export const findPortal = (id: string): Portal | undefined =>
  PORTALS.find((portal) => portal.id === id);

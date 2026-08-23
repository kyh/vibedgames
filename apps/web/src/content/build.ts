import type { Doc } from "@/lib/doc";
import { INSTALL_PROMPT } from "@/lib/install-prompt";
import { siteConfig } from "@/lib/site-config";

export type Offering = {
  index: string;
  title: string;
  /** The prompt on the card — copied to the clipboard when it is clicked. */
  tag: string;
  desc: string;
  color: string;
  zIndex: number;
};

/**
 * The five cards on `/build`. Shared with {@link buildDoc} so the markdown
 * representation of the page always lists the same offerings the deck shows.
 */
export const OFFERINGS: Offering[] = [
  {
    index: "01",
    title: "Just Chat",
    tag: "use vibedgames.com to help me build my game",
    desc: "Build, tweak, ship, all from prompting.",
    color: "#F59279",
    zIndex: 2,
  },
  {
    index: "02",
    title: "Build studio grade games",
    tag: "make a pixel art top down slasher",
    desc: "Sprites, samples, soundtracks. All generated.",
    color: "#F9B060",
    zIndex: 5,
  },
  {
    index: "03",
    title: "Big features, simple prompts",
    tag: "add real-time multiplayer",
    desc: "Multiplayer, physics, camera tracking. Just ask.",
    color: "#F5D84A",
    zIndex: 1,
  },
  {
    index: "04",
    title: "Live in seconds",
    tag: "deploy my game",
    desc: "Just say deploy and share your game with the world.",
    color: "#80D487",
    zIndex: 4,
  },
  {
    index: "05",
    title: "Learn as you build",
    tag: "/teach-me how to build a platformer",
    desc: "A built-in tutor. Learn gamedev by shipping real games.",
    color: "#73B7E5",
    zIndex: 3,
  },
];

export const buildDoc: Doc = {
  path: "/build",
  title: `Build a game with ${siteConfig.name}`,
  description: `${siteConfig.name} is a game studio for your agent — install it once, then build, generate assets, add multiplayer and ship by prompting.`,
  lead: [
    {
      kind: "p",
      text: "Paste this into Claude Code, Codex, Cursor or any coding agent that can run commands:",
    },
    { kind: "code", code: INSTALL_PROMPT },
    {
      kind: "p",
      text: "Or install directly, then keep prompting — the skills it installs carry the rest:",
    },
    { kind: "code", lang: "sh", code: "npx vibedgames init" },
  ],
  sections: [
    {
      heading: "What you can ask for",
      blocks: [
        {
          kind: "ul",
          items: OFFERINGS.map(
            (offering) => `**${offering.title}** — ${offering.desc} Try: \`${offering.tag}\``,
          ),
        },
      ],
    },
    {
      heading: "Next",
      blocks: [
        {
          kind: "p",
          text: "Read [/docs](/docs) for the full CLI and API surface, [/llms.txt](/llms.txt) if you are the agent, and [/discover](/discover) for games already shipped on the platform.",
        },
      ],
    },
  ],
};

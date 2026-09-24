import type { Doc } from "@/lib/doc";
import { INSTALL_PROMPT } from "@/lib/install-prompt";
import { siteConfig } from "@/lib/site-config";

export interface Offering {
  index: string;
  title: string;
  /** The prompt on the card — copied to the clipboard when it is clicked. */
  tag: string;
  desc: string;
  color: string;
  zIndex: number;
}

/**
 * The five cards on `/build`. Shared with {@link buildDoc} so the markdown
 * representation of the page always lists the same offerings the deck shows.
 */
export const OFFERINGS: Offering[] = [
  {
    color: "#F59279",
    desc: "Build, tweak, ship, all from prompting.",
    index: "01",
    tag: "use vibedgames.com to help me build my game",
    title: "Just Chat",
    zIndex: 2,
  },
  {
    color: "#F9B060",
    desc: "Sprites, samples, soundtracks. All generated.",
    index: "02",
    tag: "make a pixel art top down slasher",
    title: "Build studio grade games",
    zIndex: 5,
  },
  {
    color: "#F5D84A",
    desc: "Multiplayer, physics, camera tracking. Just ask.",
    index: "03",
    tag: "add real-time multiplayer",
    title: "Big features, simple prompts",
    zIndex: 1,
  },
  {
    color: "#80D487",
    desc: "Just say deploy and share your game with the world.",
    index: "04",
    tag: "deploy my game",
    title: "Live in seconds",
    zIndex: 4,
  },
  {
    color: "#73B7E5",
    desc: "A built-in tutor. Learn gamedev by shipping real games.",
    index: "05",
    tag: "/teach-me how to build a platformer",
    title: "Learn as you build",
    zIndex: 3,
  },
];

export const buildDoc: Doc = {
  description: `${siteConfig.name} is a game studio for your agent — install it once, then build, generate assets, add multiplayer and ship by prompting.`,
  lead: [
    {
      kind: "p",
      text: "Paste this into Claude Code, Codex, Cursor or any coding agent that can run commands:",
    },
    { code: INSTALL_PROMPT, kind: "code" },
    {
      kind: "p",
      text: "Or install directly, then keep prompting — the skills it installs carry the rest:",
    },
    { code: "npx vibedgames init", kind: "code", lang: "sh" },
  ],
  path: "/build",
  sections: [
    {
      blocks: [
        {
          items: OFFERINGS.map(
            (offering) => `**${offering.title}** — ${offering.desc} Try: \`${offering.tag}\``,
          ),
          kind: "ul",
        },
      ],
      heading: "What you can ask for",
    },
    {
      blocks: [
        {
          kind: "p",
          text: "Read [/docs](/docs) for the full CLI and API surface, [/llms.txt](/llms.txt) if you are the agent, and [/discover](/discover) for games already shipped on the platform.",
        },
      ],
      heading: "Next",
    },
  ],
  title: `Build a game with ${siteConfig.name}`,
};

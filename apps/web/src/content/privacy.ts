import type { Doc } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

export const privacyDoc: Doc = {
  description:
    "What Vibedgames collects to run vibedgames.com, the vg CLI and the agent skills, who processes it, and how to get it deleted.",
  lead: [
    { kind: "p", text: "Last updated September 26, 2026." },
    {
      kind: "p",
      text: "Vibedgames hosts browser games and provides the `vg` command-line tool and the vibedgames agent skills. This policy covers vibedgames.com, the game subdomains under it, the `vg` CLI and the vibedgames plugin. We collect what we need to run the service. We don’t sell your data, show ads or use third-party analytics.",
    },
  ],
  path: "/privacy",
  sections: [
    {
      blocks: [
        {
          items: [
            "**Account:** your name, email address and a hashed password.",
            "**Sessions and security:** the IP address and user agent of each signed-in session. We also count requests per IP address to rate-limit sign-in attempts.",
            "**API keys:** the keys you create for the CLI and CI, and their names.",
            "**Games:** the files you deploy, plus each game’s name and slug. If you deploy with `--source`, we also store your project source so that other signed-in users can fork it.",
            "**Generation usage:** for each asset generation request, the model used, its status and what it cost. This is how we keep your credit balance. We do not store your prompts or the generated files.",
            "**Waitlist:** your email address, if you join the waitlist.",
          ],
          kind: "ul",
        },
      ],
      heading: "What we collect",
    },
    {
      blocks: [
        {
          kind: "p",
          text: "The vibedgames skills are text files that run inside your coding agent on your machine. Nothing is sent to us until you, or your agent, run a `vg` command that talks to our servers:",
        },
        {
          items: [
            "`vg deploy` uploads your built game, and your source if you pass `--source`.",
            "`vg generate` sends your prompt and any input files to our server. We pass them on to the third-party AI model provider that fulfils the request. That provider processes them under its own terms and policies.",
            "`vg playtest run` sends snapshots of the game’s state to our server while a model plays the game. We pass them to a third-party AI model provider to choose the next move and do not keep them.",
            "Multiplayer games relay player messages through our servers to the other players in the same room.",
          ],
          kind: "ul",
        },
      ],
      heading: "How data leaves your machine",
    },
    {
      blocks: [
        {
          kind: "p",
          text: "We set one session cookie, on vibedgames.com only, to keep you signed in. Games run on separate subdomains and cannot read it. We use no tracking or advertising cookies.",
        },
      ],
      heading: "Cookies",
    },
    {
      blocks: [
        {
          items: [
            "**Cloudflare** hosts the site, the database, file storage and the multiplayer servers.",
            "**AI model providers** receive the prompts, inputs and game state described above, and only when you run a command that needs them.",
          ],
          kind: "ul",
        },
      ],
      heading: "Who processes your data",
    },
    {
      blocks: [
        {
          kind: "p",
          text: "Account data stays until you ask us to delete your account. Each game keeps only its current deployment: a new deploy replaces the old files, and deleting a game deletes its files. Credit and generation records stay with your account.",
        },
      ],
      heading: "Retention",
    },
    {
      blocks: [
        {
          kind: "p",
          text: `You can delete your games and API keys yourself. To have your account and all its data deleted, or to ask what we hold about you, [open an issue](${siteConfig.issues}) with your vibedgames username and we will follow up. Don’t include your email address or other personal details: issues are public.`,
        },
      ],
      heading: "Your choices",
    },
    {
      blocks: [
        {
          kind: "p",
          text: "Vibedgames accounts are not for children under 13, and we do not knowingly collect their data.",
        },
      ],
      heading: "Children",
    },
    {
      blocks: [
        {
          kind: "p",
          text: "When this policy changes, we will update the date at the top of this page. Also see our [Terms of Service](/terms).",
        },
      ],
      heading: "Changes",
    },
  ],
  title: "Privacy Policy",
};

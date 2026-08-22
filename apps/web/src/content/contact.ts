import type { Block, Doc } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

/**
 * Only channels that actually exist get published here. An email address or a
 * postal address appears the moment `siteConfig.contact` is filled in and not
 * a moment sooner — a contact route nobody monitors is worse than none.
 */
const directBlocks: Block[] = [];
if (siteConfig.contact.email) {
  directBlocks.push({
    kind: "p",
    text: `Email: [${siteConfig.contact.email}](mailto:${siteConfig.contact.email})`,
  });
}
if (siteConfig.contact.telephone) {
  directBlocks.push({ kind: "p", text: `Phone: ${siteConfig.contact.telephone}` });
}
if (siteConfig.contact.address) {
  const a = siteConfig.contact.address;
  directBlocks.push({
    kind: "p",
    text: `Postal address: ${[a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry].filter(Boolean).join(", ")}`,
  });
}

export const contactDoc: Doc = {
  path: "/contact",
  title: "Contact Vibedgames",
  description:
    "How to reach the Vibedgames team: GitHub issues for bugs and support, discussions for questions, and the security and account channels.",
  lead: [
    {
      kind: "p",
      text: "Vibedgames is developed in the open, and so is its support. Every channel below is public and monitored by the maintainers — filing in the open means the answer is searchable by the next person, and by the next agent, instead of disappearing into a private inbox.",
    },
  ],
  sections: [
    {
      heading: "Bugs and feature requests",
      blocks: [
        {
          kind: "p",
          text: `Open an issue at [${siteConfig.issues}](${siteConfig.issues}). Include the command you ran, the full output (add \`--json\` if it was a \`vg\` command), the CLI version from \`vg --version\`, and the game slug if a deploy is involved. Issues covering the CLI, the web app, the multiplayer package and the agent skills all belong in that one repository.`,
        },
      ],
    },
    {
      heading: "Questions and help building",
      blocks: [
        {
          kind: "p",
          text: `Ask in [GitHub Discussions](${siteConfig.discussions}) for anything that is not a defect: which model endpoint to use, how to structure a multiplayer game, whether a genre is a good fit. If your agent is stuck, paste the transcript — the skills are versioned in the same repository, so a bad instruction is a fixable bug.`,
        },
      ],
    },
    {
      heading: "Security reports",
      blocks: [
        {
          kind: "p",
          text: `Report suspected vulnerabilities privately through GitHub's security advisory form on [${siteConfig.repository}](${siteConfig.repository}/security/advisories/new) rather than in a public issue. Please include reproduction steps and hold off on public disclosure until a fix has shipped. Reports about a specific deployed game — abuse, malware, or content that should not be hosted — should name the \`{slug}.vibedgames.com\` subdomain.`,
        },
      ],
    },
    {
      heading: "Account, data and billing",
      blocks: [
        {
          kind: "p",
          text: "Account settings, generation-credit balance and API keys live at [/settings](/settings) once you are signed in. For data export or account deletion, see [Privacy](/privacy), which describes exactly what is stored and how to have it removed.",
        },
        ...directBlocks,
      ],
    },
    {
      heading: "Press and partnerships",
      blocks: [
        {
          kind: "p",
          text: `Reach ${siteConfig.author.name} at [${siteConfig.twitter}](${siteConfig.author.url}) for press, partnership or platform-integration enquiries. Brand assets and the canonical description of the product are on the [About](/about) page.`,
        },
      ],
    },
  ],
};

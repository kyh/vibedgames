export type PostalAddress = {
  streetAddress?: string;
  addressLocality: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry: string;
};

/**
 * Contact details for `Organization.contactPoint` / `.address`.
 *
 * Left unset deliberately: schema.org contact data is a legitimacy signal that
 * agents and AI search surface verbatim, so publishing a mailbox nobody reads
 * (or an address nobody occupies) is worse than publishing none. Fill these in
 * with a monitored address and they flow into the homepage JSON-LD and
 * `/contact` automatically — see `lib/structured-data.ts`.
 */
export type SiteContact = {
  email: string | null;
  telephone: string | null;
  address: PostalAddress | null;
};

const contact: SiteContact = {
  email: null,
  telephone: null,
  address: null,
};

export const siteConfig = {
  name: "Vibedgames",
  shortName: "Vibedgames",
  description: "A game studio for your agent",
  /**
   * One sentence of what the product actually does, for the places that need
   * more than the tagline: JSON-LD, llms.txt, the SSR summary on `/`.
   */
  summary:
    "Vibedgames is an agent-native platform for building, hosting and shipping browser games: a coding agent installs the vg CLI and the bundled game-studio skills, generates art and audio, adds real-time multiplayer, and deploys the game to its own {slug}.vibedgames.com subdomain.",
  url: "https://vibedgames.com",
  twitter: "@kaiyuhsu",
  /**
   * Verifiable public identities for schema.org `sameAs`. Only add a profile
   * that actually exists and is controlled by the project — `sameAs` is an
   * entity-resolution signal, and a dead link is worse than a short list.
   */
  sameAs: ["https://github.com/kyh/vibedgames", "https://x.com/kaiyuhsu"],
  repository: "https://github.com/kyh/vibedgames",
  issues: "https://github.com/kyh/vibedgames/issues",
  discussions: "https://github.com/kyh/vibedgames/discussions",
  npm: "https://www.npmjs.com/package/vibedgames",
  author: {
    name: "Kaiyu Hsu",
    url: "https://x.com/kaiyuhsu",
  },
  contact,
};

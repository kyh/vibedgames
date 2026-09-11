import type { PostalAddress } from "@/lib/site-config";
import { featuredGames, gameUrl } from "@/components/game/data";
import { siteConfig } from "@/lib/site-config";

/**
 * schema.org JSON-LD for the apex domain.
 *
 * One `@graph` with stable `@id`s, so the Organization, the WebSite and the
 * SoftwareApplication resolve to the same three entities on every page instead
 * of minting a new anonymous node per route. Emitted server-side in the
 * document head — see `routes/__root.tsx` — because the whole point is that a
 * crawler that never runs JavaScript can still read it.
 */

const ORG_ID = `${siteConfig.url}/#organization`;
const SITE_ID = `${siteConfig.url}/#website`;
const APP_ID = `${siteConfig.url}/#software`;

/**
 * `T`, if it is JSON-LD-shaped: primitives, arrays of the same, and objects
 * whose every declared member is. A mapped type rather than an index
 * signature on purpose — the graph nodes are interfaces, and an interface
 * never satisfies `{ [key: string]: ... }` because declaration merging could
 * add members later. Mapping over the members checks exactly what is there,
 * and still rejects a `Date`, a `Map` or a method.
 */
export type JsonLd<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer TItem)[]
    ? readonly JsonLd<TItem>[]
    : T extends object
      ? { readonly [K in keyof T]: JsonLd<T[K]> }
      : never;

interface NodeRef {
  "@id": string;
}

interface PersonNode {
  "@type": "Person";
  name: string;
  url: string;
}

interface ContactPointNode {
  "@type": "ContactPoint";
  contactType: string;
  url: string;
  availableLanguage: string[];
  email?: string;
  telephone?: string;
}

type PostalAddressNode = { "@type": "PostalAddress" } & PostalAddress;

export interface OrganizationNode {
  "@type": "Organization";
  "@id": string;
  name: string;
  url: string;
  description: string;
  logo: string;
  image: string;
  sameAs: string[];
  founder: PersonNode;
  contactPoint: ContactPointNode[];
  email?: string;
  telephone?: string;
  address?: PostalAddressNode;
}

export interface WebSiteNode {
  "@type": "WebSite";
  "@id": string;
  url: string;
  name: string;
  description: string;
  inLanguage: string;
  publisher: NodeRef;
}

export interface SoftwareApplicationNode {
  "@type": "SoftwareApplication";
  "@id": string;
  name: string;
  url: string;
  description: string;
  applicationCategory: string;
  applicationSubCategory: string;
  operatingSystem: string;
  image: string;
  softwareHelp: { "@type": "CreativeWork"; url: string };
  installUrl: string;
  downloadUrl: string;
  license: string;
  isAccessibleForFree: boolean;
  author: NodeRef;
  publisher: NodeRef;
  featureList: string[];
  offers: {
    "@type": "Offer";
    price: string;
    priceCurrency: string;
    description: string;
  };
}

export interface VideoGameNode {
  "@type": "VideoGame";
  name: string;
  url: string;
  image: string;
  gamePlatform: string;
  applicationCategory: string;
  publisher: NodeRef;
}

export type SiteGraphNode =
  | OrganizationNode
  | WebSiteNode
  | SoftwareApplicationNode
  | VideoGameNode;

export interface SiteGraph {
  "@context": "https://schema.org";
  "@graph": SiteGraphNode[];
}

const organizationSchema = (): OrganizationNode => {
  const { contact } = siteConfig;

  // Only publish contact fields that are real. See `siteConfig.contact`.
  const contactPoint: ContactPointNode = {
    "@type": "ContactPoint",
    availableLanguage: ["English"],
    contactType: "technical support",
    url: siteConfig.issues,
  };
  if (contact.email) {
    contactPoint.email = contact.email;
  }
  if (contact.telephone) {
    contactPoint.telephone = contact.telephone;
  }

  const organization: OrganizationNode = {
    "@id": ORG_ID,
    "@type": "Organization",
    contactPoint: [contactPoint],
    description: siteConfig.summary,
    founder: { "@type": "Person", name: siteConfig.author.name, url: siteConfig.author.url },
    image: `${siteConfig.url}/og.jpg`,
    logo: `${siteConfig.url}/favicon/web-app-manifest-512x512.png`,
    name: siteConfig.name,
    sameAs: siteConfig.sameAs,
    url: siteConfig.url,
  };
  if (contact.email) {
    organization.email = contact.email;
  }
  if (contact.telephone) {
    organization.telephone = contact.telephone;
  }
  if (contact.address) {
    organization.address = { "@type": "PostalAddress", ...contact.address };
  }
  return organization;
};

const webSiteSchema = (): WebSiteNode => ({
  "@id": SITE_ID,
  "@type": "WebSite",
  description: siteConfig.description,
  inLanguage: "en",
  name: siteConfig.name,
  publisher: { "@id": ORG_ID },
  url: siteConfig.url,
});

const softwareApplicationSchema = (): SoftwareApplicationNode => ({
  "@id": APP_ID,
  "@type": "SoftwareApplication",
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Game development platform",
  author: { "@id": ORG_ID },
  description: siteConfig.summary,
  downloadUrl: siteConfig.npm,
  featureList: [
    "Deploy browser games to a {slug}.vibedgames.com subdomain from the CLI",
    "Host static game bundles on Cloudflare's edge",
    "Add host-authoritative real-time multiplayer with @vibedgames/multiplayer",
    "Generate sprites, textures, video, music and sound effects with vg generate",
    "Install game-design, engine and shipping skills into a coding agent",
  ],
  image: `${siteConfig.url}/og.jpg`,
  installUrl: `${siteConfig.url}/install`,
  isAccessibleForFree: true,
  license: `${siteConfig.repository}/blob/main/LICENSE`,
  name: siteConfig.name,
  offers: {
    "@type": "Offer",
    description:
      "Deploys, hosting and multiplayer are free. Asset generation is metered against a per-account credit balance, starting with a $20 signup grant.",
    price: "0",
    priceCurrency: "USD",
  },
  operatingSystem: "Any (web-based; CLI requires Node.js)",
  publisher: { "@id": ORG_ID },
  softwareHelp: { "@type": "CreativeWork", url: `${siteConfig.url}/docs` },
  url: siteConfig.url,
});

/** The three site-wide entities, plus the games currently featured on `/`. */
export const siteGraph = (): SiteGraph => ({
  "@context": "https://schema.org",
  "@graph": [
    organizationSchema(),
    webSiteSchema(),
    softwareApplicationSchema(),
    ...featuredGames.map<VideoGameNode>((game) => ({
      "@type": "VideoGame",
      applicationCategory: "Game",
      gamePlatform: "Web browser",
      image: `${siteConfig.url}${game.preview}`,
      name: game.name,
      publisher: { "@id": ORG_ID },
      url: gameUrl(game.slug),
    })),
  ],
});

/**
 * Serialize for embedding in a `<script type="application/ld+json">`.
 *
 * `<` is escaped so a `</script>` sequence inside any string can never close
 * the tag early — the standard guard for inline JSON in HTML.
 */
export const serializeJsonLd = <T>(value: T & JsonLd<T>): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");

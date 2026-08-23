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

/** Anything that can appear in a JSON-LD document. */
export type JsonLdValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonLdValue[]
  | { readonly [key: string]: JsonLdValue };

type NodeRef = { "@id": string };

type PersonNode = { "@type": "Person"; name: string; url: string };

type ContactPointNode = {
  "@type": "ContactPoint";
  contactType: string;
  url: string;
  availableLanguage: string[];
  email?: string;
  telephone?: string;
};

type PostalAddressNode = { "@type": "PostalAddress" } & PostalAddress;

export type OrganizationNode = {
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
};

export type WebSiteNode = {
  "@type": "WebSite";
  "@id": string;
  url: string;
  name: string;
  description: string;
  inLanguage: string;
  publisher: NodeRef;
};

export type SoftwareApplicationNode = {
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
};

export type VideoGameNode = {
  "@type": "VideoGame";
  name: string;
  url: string;
  image: string;
  gamePlatform: string;
  applicationCategory: string;
  publisher: NodeRef;
};

export type SiteGraphNode =
  | OrganizationNode
  | WebSiteNode
  | SoftwareApplicationNode
  | VideoGameNode;

export type SiteGraph = {
  "@context": "https://schema.org";
  "@graph": SiteGraphNode[];
};

function organizationSchema(): OrganizationNode {
  const { contact } = siteConfig;

  // Only publish contact fields that are real. See `siteConfig.contact`.
  const contactPoint: ContactPointNode = {
    "@type": "ContactPoint",
    contactType: "technical support",
    url: siteConfig.issues,
    availableLanguage: ["English"],
  };
  if (contact.email) contactPoint.email = contact.email;
  if (contact.telephone) contactPoint.telephone = contact.telephone;

  const organization: OrganizationNode = {
    "@type": "Organization",
    "@id": ORG_ID,
    name: siteConfig.name,
    url: siteConfig.url,
    description: siteConfig.summary,
    logo: `${siteConfig.url}/favicon/web-app-manifest-512x512.png`,
    image: `${siteConfig.url}/og.jpg`,
    sameAs: siteConfig.sameAs,
    founder: { "@type": "Person", name: siteConfig.author.name, url: siteConfig.author.url },
    contactPoint: [contactPoint],
  };
  if (contact.email) organization.email = contact.email;
  if (contact.telephone) organization.telephone = contact.telephone;
  if (contact.address) organization.address = { "@type": "PostalAddress", ...contact.address };
  return organization;
}

function webSiteSchema(): WebSiteNode {
  return {
    "@type": "WebSite",
    "@id": SITE_ID,
    url: siteConfig.url,
    name: siteConfig.name,
    description: siteConfig.description,
    inLanguage: "en",
    publisher: { "@id": ORG_ID },
  };
}

function softwareApplicationSchema(): SoftwareApplicationNode {
  return {
    "@type": "SoftwareApplication",
    "@id": APP_ID,
    name: siteConfig.name,
    url: siteConfig.url,
    description: siteConfig.summary,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Game development platform",
    operatingSystem: "Any (web-based; CLI requires Node.js)",
    image: `${siteConfig.url}/og.jpg`,
    softwareHelp: { "@type": "CreativeWork", url: `${siteConfig.url}/docs` },
    installUrl: `${siteConfig.url}/install`,
    downloadUrl: siteConfig.npm,
    license: `${siteConfig.repository}/blob/main/LICENSE`,
    isAccessibleForFree: true,
    author: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    featureList: [
      "Deploy browser games to a {slug}.vibedgames.com subdomain from the CLI",
      "Host static game bundles on Cloudflare's edge",
      "Add host-authoritative real-time multiplayer with @vibedgames/multiplayer",
      "Generate sprites, textures, video, music and sound effects with vg generate",
      "Install game-design, engine and shipping skills into a coding agent",
    ],
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description:
        "Deploys, hosting and multiplayer are free. Asset generation is metered against a per-account credit balance, starting with a $20 signup grant.",
    },
  };
}

/** The three site-wide entities, plus the games currently featured on `/`. */
export function siteGraph(): SiteGraph {
  return {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      webSiteSchema(),
      softwareApplicationSchema(),
      ...featuredGames.map<VideoGameNode>((game) => ({
        "@type": "VideoGame",
        name: game.name,
        url: gameUrl(game.slug),
        image: `${siteConfig.url}${game.preview}`,
        gamePlatform: "Web browser",
        applicationCategory: "Game",
        publisher: { "@id": ORG_ID },
      })),
    ],
  };
}

/**
 * Serialize for embedding in a `<script type="application/ld+json">`.
 *
 * `<` is escaped so a `</script>` sequence inside any string can never close
 * the tag early — the standard guard for inline JSON in HTML.
 */
export function serializeJsonLd(value: JsonLdValue): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

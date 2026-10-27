import type { Doc } from "@/lib/doc";
import type { PostalAddress } from "@/lib/site-config";
import { featuredGames, gameUrl } from "@/components/game/data";
import { pageLastModified } from "@/content/site-map";
import { pageImage, siteVideo } from "@/lib/og-media";
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
const VIDEO_ID = `${siteConfig.url}/#video`;

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
  video: NodeRef;
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

export interface VideoObjectNode {
  "@type": "VideoObject";
  "@id": string;
  name: string;
  description: string;
  thumbnailUrl: string;
  contentUrl: string;
  uploadDate: string;
  duration: string;
  width: number;
  height: number;
  encodingFormat: string;
  isFamilyFriendly: boolean;
  publisher: NodeRef;
}

export type SiteGraphNode =
  | OrganizationNode
  | WebSiteNode
  | SoftwareApplicationNode
  | VideoObjectNode
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
      "Deploys, hosting and multiplayer are free. Asset generation is metered against a per-account credit balance, bought by card or granted by code.",
    price: "0",
    priceCurrency: "USD",
  },
  operatingSystem: "Any (web-based; CLI requires Node.js)",
  publisher: { "@id": ORG_ID },
  softwareHelp: { "@type": "CreativeWork", url: `${siteConfig.url}/docs` },
  url: siteConfig.url,
  video: { "@id": VIDEO_ID },
});

/** The trailer `og:video` points at, as the entity it is. */
const videoObjectSchema = (): VideoObjectNode => ({
  "@id": VIDEO_ID,
  "@type": "VideoObject",
  contentUrl: `${siteConfig.url}${siteVideo.path}`,
  description: siteVideo.description,
  duration: siteVideo.duration,
  encodingFormat: siteVideo.type,
  height: siteVideo.height,
  isFamilyFriendly: true,
  name: siteVideo.name,
  publisher: { "@id": ORG_ID },
  thumbnailUrl: `${siteConfig.url}${siteVideo.poster}`,
  uploadDate: siteVideo.uploadDate,
  width: siteVideo.width,
});

/** The three site-wide entities, plus the games currently featured on `/`. */
export const siteGraph = (): SiteGraph => ({
  "@context": "https://schema.org",
  "@graph": [
    organizationSchema(),
    webSiteSchema(),
    softwareApplicationSchema(),
    videoObjectSchema(),
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

interface BreadcrumbListNode {
  "@type": "BreadcrumbList";
  itemListElement: {
    "@type": "ListItem";
    position: number;
    name: string;
    item: string;
  }[];
}

/** schema.org types a prose page can be, picked by what the page is for. */
type PageType = "AboutPage" | "ContactPage" | "TechArticle" | "WebPage";

export interface PageNode {
  "@type": PageType;
  "@id": string;
  url: string;
  name: string;
  headline: string;
  description: string;
  inLanguage: string;
  image: string;
  dateModified: string;
  isPartOf: NodeRef;
  publisher: NodeRef;
  about?: NodeRef;
  author?: NodeRef;
  breadcrumb?: BreadcrumbListNode;
}

export interface PageGraph {
  "@context": "https://schema.org";
  "@graph": PageNode[];
}

const pageTypeOf = (path: string): PageType => {
  switch (path) {
    case "/about": {
      return "AboutPage";
    }
    case "/contact": {
      return "ContactPage";
    }
    case "/build":
    case "/docs": {
      return "TechArticle";
    }
    default: {
      return "WebPage";
    }
  }
};

/** Absolute URL of a site path; the apex is the bare origin. */
const absolute = (path: string) => (path === "/" ? siteConfig.url : `${siteConfig.url}${path}`);

/**
 * The page-level node for one prose page: what it is (`TechArticle` for the
 * docs, `AboutPage` / `ContactPage` for the trust pages, `WebPage` otherwise),
 * hung off the site graph's stable `@id`s, plus a breadcrumb back to `/`.
 * Emitted by `docHead`, beside — not inside — the site graph the root route
 * carries.
 */
export const pageGraph = (doc: Doc): PageGraph => {
  const url = absolute(doc.path);
  const type = pageTypeOf(doc.path);
  const page: PageNode = {
    "@id": `${url}#webpage`,
    "@type": type,
    dateModified: pageLastModified(doc.path),
    description: doc.description,
    headline: doc.title,
    image: `${siteConfig.url}${pageImage(doc.path)}`,
    inLanguage: "en",
    isPartOf: { "@id": SITE_ID },
    name: doc.title,
    publisher: { "@id": ORG_ID },
    url,
  };
  if (type === "TechArticle") {
    page.about = { "@id": APP_ID };
    page.author = { "@id": ORG_ID };
  }
  if (doc.path !== "/") {
    page.breadcrumb = {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", item: siteConfig.url, name: siteConfig.name, position: 1 },
        { "@type": "ListItem", item: url, name: doc.title, position: 2 },
      ],
    };
  }
  return { "@context": "https://schema.org", "@graph": [page] };
};

/**
 * Serialize for embedding in a `<script type="application/ld+json">`.
 *
 * `<` is escaped so a `</script>` sequence inside any string can never close
 * the tag early — the standard guard for inline JSON in HTML.
 */
export const serializeJsonLd = <T>(value: T & JsonLd<T>): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");

const RESERVED_SLUGS = new Set<string>([
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "cdn",
  "dashboard",
  "dev",
  "docs",
  "games",
  "mail",
  "party",
  "static",
  "status",
  "support",
  "www",
  "_v",
]);

export const isSlugReserved = (slug: string) => RESERVED_SLUGS.has(slug.toLowerCase());

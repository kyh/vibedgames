/**
 * Slugs that cannot be used for user games because they collide with platform
 * subdomains or reserved namespaces.
 */
export const RESERVED_SLUGS = new Set<string>([
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

export function isSlugReserved(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

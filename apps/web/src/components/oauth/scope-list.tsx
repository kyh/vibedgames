import { OAUTH_SCOPES } from "@repo/contract/auth/oauth-scopes";

/**
 * What each scope lets an app do, in the person's terms: OpenID's, then
 * vibedgames' own (`@repo/contract/auth/oauth-scopes`), in the order shown.
 */
const SCOPE_LABELS = new Map<string, string>([
  ["openid", "Know who you are"],
  ["profile", "See your name and picture"],
  ["email", "See your email address"],
  ...Object.entries(OAUTH_SCOPES),
  ["offline_access", "Stay connected while you are away"],
]);

/** The scopes an app asks for, as the list the consent and device pages show. */
export const ScopeList = ({ scopes }: { scopes: readonly string[] }) => (
  <ul className="text-muted-foreground list-disc space-y-1 pl-5">
    {[...SCOPE_LABELS].flatMap(([scope, label]) =>
      scopes.includes(scope) ? [<li key={scope}>{label}</li>] : [],
    )}
  </ul>
);

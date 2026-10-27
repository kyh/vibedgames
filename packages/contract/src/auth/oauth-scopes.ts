/**
 * What an app a person connects over OAuth may do, one scope per kind of
 * action. Every procedure an access token can reach names the one it needs
 * (`requiresScope` in `base.ts`); `root-router.test.ts` holds each to it.
 * Session cookies, session tokens and API keys carry no scopes: they act as
 * the person in full. Zod-free, so the consent page can label them.
 */
export const OAUTH_SCOPES = {
  "credits:read": "See your credit balance",
  "credits:write": "Buy credits and redeem credit codes",
  "games:read": "See your games and download their source",
  "games:write": "Deploy, update and delete your games",
  generate: "Generate images, audio, video and 3D with your credits",
  playtest: "Let a model playtest your games",
} as const;

export type OAuthScope = keyof typeof OAUTH_SCOPES;

/**
 * What a procedure requires of an access token: one of the scopes above, or
 * OpenID's `profile` for reading who the token belongs to.
 */
export type RequiredScope = OAuthScope | "profile";

export const isOAuthScope = (scope: string): scope is OAuthScope =>
  Object.hasOwn(OAUTH_SCOPES, scope);

import { sql } from "drizzle-orm";
import { index, sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const user = sqliteTable(
  "user",
  {
    banExpires: integer("ban_expires", { mode: "timestamp_ms" }),
    banReason: text("ban_reason"),
    banned: integer("banned", { mode: "boolean" }).default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
    id: text("id").primaryKey(),
    image: text("image"),
    invitedByCode: text("invited_by_code"),
    name: text("name").notNull(),
    role: text("role"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex("user_email_unique").on(table.email)],
);

export const session = sqliteTable(
  "session",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    impersonatedBy: text("impersonated_by"),
    ipAddress: text("ip_address"),
    token: text("token").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("session_token_unique").on(table.token)],
);

// better-auth 1.7 scopes account identity by `(issuer, accountId)` rather than
// `(providerId, accountId)`: `issuer` is required and the pair must be unique.
// Credential accounts use `local:credential`; an OAuth provider without a real
// issuer uses `local:oauth:<providerId>`.
export const account = sqliteTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    accountId: text("account_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    issuer: text("issuer").notNull(),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("account_issuer_accountId_uidx").on(table.issuer, table.accountId)],
);

export const verification = sqliteTable("verification", {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
  value: text("value").notNull(),
});

// Managed by the @better-auth/api-key plugin. Property names MUST match the
// plugin's logical field names (the drizzle adapter looks tables up by field
// name); SQL column names are spelled explicitly, in snake_case.
// `referenceId` is the owning user id (the plugin's default `references: user`).
export const apikey = sqliteTable(
  "apikey",
  {
    configId: text("config_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    id: text("id").primaryKey().notNull(),
    key: text("key").notNull(),
    lastRefillAt: integer("last_refill_at", { mode: "timestamp_ms" }),
    lastRequest: integer("last_request", { mode: "timestamp_ms" }),
    metadata: text("metadata"),
    name: text("name"),
    permissions: text("permissions"),
    prefix: text("prefix"),
    rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }).default(true),
    rateLimitMax: integer("rate_limit_max"),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    referenceId: text("reference_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    refillAmount: integer("refill_amount"),
    refillInterval: integer("refill_interval"),
    remaining: integer("remaining"),
    requestCount: integer("request_count").default(0),
    start: text("start"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("apikey_configId_idx").on(table.configId),
    index("apikey_key_idx").on(table.key),
    index("apikey_referenceId_idx").on(table.referenceId),
  ],
);

// better-auth's database rate-limit store (rateLimit.storage = "database" in
// auth.ts). Keyed by IP+path; `key` is unique so the counter upsert is a single
// indexed lookup. `lastRequest` is the raw epoch-ms number the store writes
// (not a Date), so it stays a plain integer column. Hand-added — the @better-auth
// CLI regen emits this table too, so keep it if you regenerate the schema.
export const rateLimit = sqliteTable(
  "rate_limit",
  {
    count: integer("count").notNull(),
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    lastRequest: integer("last_request").notNull(),
  },
  (table) => [uniqueIndex("rate_limit_key_unique").on(table.key)],
);

// ---- MCP OAuth (@better-auth/mcp + @better-auth/cimd + jwt) -------------------
// Mirrors the tables better-auth derives for the OAuth provider; the shape is
// checked by `auth-tables.test.ts`. List fields (`scopes`, `redirectUris`, ...)
// and JSON fields are `mode: "json"` text: the drizzle adapter hands them over
// as arrays/objects, and D1 can't bind those without Drizzle serialising them.

const createdAtNow = () =>
  integer("created_at", { mode: "timestamp_ms" }).default(
    sql`(cast(unixepoch('subsecond') * 1000 as integer))`,
  );

export const jwks = sqliteTable("jwks", {
  alg: text("alg"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  crv: text("crv"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  id: text("id").primaryKey(),
  privateKey: text("private_key").notNull(),
  publicKey: text("public_key").notNull(),
});

export const oauthClient = sqliteTable(
  "oauth_client",
  {
    applicationType: text("application_type"),
    backchannelLogoutSessionRequired: integer("backchannel_logout_session_required", {
      mode: "boolean",
    }),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    clientCredentialsScopes: text("client_credentials_scopes", { mode: "json" }).default([]),
    clientDiscoveryId: text("client_discovery_id"),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret"),
    contacts: text("contacts", { mode: "json" }),
    createdAt: createdAtNow(),
    disabled: integer("disabled", { mode: "boolean" }).default(false),
    dpopBoundAccessTokens: integer("dpop_bound_access_tokens", { mode: "boolean" }).default(false),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    grantTypes: text("grant_types", { mode: "json" }),
    icon: text("icon"),
    id: text("id").primaryKey(),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    metadata: text("metadata", { mode: "json" }),
    name: text("name"),
    policy: text("policy"),
    postLogoutRedirectUris: text("post_logout_redirect_uris", { mode: "json" }),
    redirectUris: text("redirect_uris", { mode: "json" }).notNull(),
    referenceId: text("reference_id"),
    requirePKCE: integer("require_pkce", { mode: "boolean" }),
    responseTypes: text("response_types", { mode: "json" }),
    scopes: text("scopes", { mode: "json" }),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    softwareId: text("software_id"),
    softwareStatement: text("software_statement"),
    softwareVersion: text("software_version"),
    subjectType: text("subject_type"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    tos: text("tos"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$onUpdate(() => new Date()),
    uri: text("uri"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("oauth_client_client_id_unique").on(table.clientId),
    index("oauth_client_user_id_idx").on(table.userId),
  ],
);

export const oauthResource = sqliteTable(
  "oauth_resource",
  {
    accessTokenTtl: integer("access_token_ttl"),
    allowedScopes: text("allowed_scopes", { mode: "json" }),
    createdAt: createdAtNow(),
    customClaims: text("custom_claims", { mode: "json" }),
    disabled: integer("disabled", { mode: "boolean" }).default(false),
    dpopBoundAccessTokensRequired: integer("dpop_bound_access_tokens_required", {
      mode: "boolean",
    }).default(false),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    metadata: text("metadata", { mode: "json" }),
    name: text("name").notNull(),
    policyVersion: integer("policy_version").default(1),
    refreshTokenTtl: integer("refresh_token_ttl"),
    signingAlgorithm: text("signing_algorithm"),
    signingKeyId: text("signing_key_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("oauth_resource_identifier_unique").on(table.identifier)],
);

export const oauthClientResource = sqliteTable(
  "oauth_client_resource",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    createdAt: createdAtNow(),
    id: text("id").primaryKey(),
    metadata: text("metadata", { mode: "json" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
  },
  (table) => [
    index("oauth_client_resource_client_id_idx").on(table.clientId),
    index("oauth_client_resource_resource_id_idx").on(table.resourceId),
  ],
);

export const oauthRefreshToken = sqliteTable(
  "oauth_refresh_token",
  {
    authTime: integer("auth_time", { mode: "timestamp_ms" }),
    authorizationCodeId: text("authorization_code_id"),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    confirmation: text("confirmation", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    id: text("id").primaryKey(),
    referenceId: text("reference_id"),
    requestedUserInfoClaims: text("requested_user_info_claims", { mode: "json" }),
    resources: text("resources", { mode: "json" }),
    revoked: integer("revoked", { mode: "timestamp_ms" }),
    rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
    rotationReplayExpiresAt: integer("rotation_replay_expires_at", { mode: "timestamp_ms" }),
    rotationReplayResponse: text("rotation_replay_response"),
    scopes: text("scopes", { mode: "json" }).notNull(),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    token: text("token").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("oauth_refresh_token_token_unique").on(table.token),
    index("oauth_refresh_token_client_id_idx").on(table.clientId),
    index("oauth_refresh_token_session_id_idx").on(table.sessionId),
    index("oauth_refresh_token_user_id_idx").on(table.userId),
    index("oauth_refresh_token_authorization_code_id_idx").on(table.authorizationCodeId),
  ],
);

export const oauthAccessToken = sqliteTable(
  "oauth_access_token",
  {
    authorizationCodeId: text("authorization_code_id"),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    confirmation: text("confirmation", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    id: text("id").primaryKey(),
    referenceId: text("reference_id"),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    requestedUserInfoClaims: text("requested_user_info_claims", { mode: "json" }),
    resources: text("resources", { mode: "json" }),
    revoked: integer("revoked", { mode: "timestamp_ms" }),
    scopes: text("scopes", { mode: "json" }).notNull(),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    token: text("token"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("oauth_access_token_token_unique").on(table.token),
    index("oauth_access_token_client_id_idx").on(table.clientId),
    index("oauth_access_token_session_id_idx").on(table.sessionId),
    index("oauth_access_token_user_id_idx").on(table.userId),
    index("oauth_access_token_authorization_code_id_idx").on(table.authorizationCodeId),
    index("oauth_access_token_refresh_id_idx").on(table.refreshId),
  ],
);

export const oauthConsent = sqliteTable(
  "oauth_consent",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    id: text("id").primaryKey(),
    referenceId: text("reference_id"),
    requestedUserInfoClaims: text("requested_user_info_claims", { mode: "json" }),
    resources: text("resources", { mode: "json" }),
    scopes: text("scopes", { mode: "json" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$onUpdate(() => new Date()),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("oauth_consent_client_id_idx").on(table.clientId),
    index("oauth_consent_user_id_idx").on(table.userId),
  ],
);

export const oauthClientAssertion = sqliteTable("oauth_client_assertion", {
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  id: text("id").primaryKey(),
});

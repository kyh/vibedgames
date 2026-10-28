import { and, desc, eq, gt, isNull, or } from "@repo/db";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from "@repo/db/drizzle-schema-auth";
import { ORPCError } from "@orpc/server";

import { os, rejectApiKey, requireSession } from "../orpc";

const sessionOnly = os.connectedApps.use(requireSession).use(rejectApiKey);

interface ConnectedApp {
  clientId: string;
  connectedAt: Date | null;
  name: string | null;
  scopes: string[];
  uri: string | null;
}

/**
 * An app is connected while the person has consented to it or it holds a
 * live refresh token: a device-code grant (`vg login`) records no consent,
 * since the `/device` page is its approval. The provider's own consent
 * endpoints see only the first kind, and deleting a consent leaves the app's
 * refresh tokens alive, so it keeps minting access. Disconnecting here
 * deletes the consent and every token row the app holds for this person in
 * one batch. JWT access tokens are not stored and run out within the hour.
 */
export const connectedAppsRouter = {
  list: sessionOnly.list.handler(async ({ context }) => {
    const userId = context.session.user.id;
    const [consented, refreshing] = await context.db.batch([
      context.db
        .select({
          clientId: oauthConsent.clientId,
          connectedAt: oauthConsent.createdAt,
          name: oauthClient.name,
          scopes: oauthConsent.scopes,
          uri: oauthClient.uri,
        })
        .from(oauthConsent)
        .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
        .where(eq(oauthConsent.userId, userId))
        .orderBy(desc(oauthConsent.createdAt)),
      context.db
        .select({
          clientId: oauthRefreshToken.clientId,
          connectedAt: oauthRefreshToken.createdAt,
          name: oauthClient.name,
          scopes: oauthRefreshToken.scopes,
          uri: oauthClient.uri,
        })
        .from(oauthRefreshToken)
        .innerJoin(oauthClient, eq(oauthClient.clientId, oauthRefreshToken.clientId))
        .where(
          and(
            eq(oauthRefreshToken.userId, userId),
            isNull(oauthRefreshToken.revoked),
            or(isNull(oauthRefreshToken.expiresAt), gt(oauthRefreshToken.expiresAt, new Date())),
          ),
        )
        .orderBy(desc(oauthRefreshToken.createdAt)),
    ]);
    // One row per app: its consent when there is one, else its newest token.
    const apps = new Map<string, ConnectedApp>();
    for (const app of [...consented, ...refreshing]) {
      if (!apps.has(app.clientId)) {
        apps.set(app.clientId, app);
      }
    }
    return { apps: [...apps.values()] };
  }),

  revoke: sessionOnly.revoke.handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const owned = (
      table: typeof oauthConsent | typeof oauthRefreshToken | typeof oauthAccessToken,
    ) => and(eq(table.clientId, input.clientId), eq(table.userId, userId));
    const [consents, refreshTokens] = await context.db.batch([
      context.db.delete(oauthConsent).where(owned(oauthConsent)).returning({ id: oauthConsent.id }),
      context.db
        .delete(oauthRefreshToken)
        .where(owned(oauthRefreshToken))
        .returning({ id: oauthRefreshToken.id }),
      context.db.delete(oauthAccessToken).where(owned(oauthAccessToken)),
    ]);
    if (consents.length === 0 && refreshTokens.length === 0) {
      throw new ORPCError("NOT_FOUND", { message: "You have not connected that app." });
    }
    return { clientId: input.clientId };
  }),
};

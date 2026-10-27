import { and, desc, eq } from "@repo/db";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from "@repo/db/drizzle-schema-auth";
import { ORPCError } from "@orpc/server";

import { os, rejectApiKey, requireSession } from "../orpc";

const sessionOnly = os.connectedApps.use(requireSession).use(rejectApiKey);

/**
 * The OAuth provider's own consent endpoints list and delete consent rows,
 * but deleting one leaves the app's refresh tokens alive, so it keeps minting
 * access. Disconnecting here deletes the consent and every token row the app
 * holds for this person in one batch. JWT access tokens are not stored and
 * run out within the hour.
 */
export const connectedAppsRouter = {
  list: sessionOnly.list.handler(async ({ context }) => {
    const rows = await context.db
      .select({
        clientId: oauthConsent.clientId,
        connectedAt: oauthConsent.createdAt,
        name: oauthClient.name,
        scopes: oauthConsent.scopes,
        uri: oauthClient.uri,
      })
      .from(oauthConsent)
      .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
      .where(eq(oauthConsent.userId, context.session.user.id))
      .orderBy(desc(oauthConsent.createdAt));
    return { apps: rows };
  }),

  revoke: sessionOnly.revoke.handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const owned = (
      table: typeof oauthConsent | typeof oauthRefreshToken | typeof oauthAccessToken,
    ) => and(eq(table.clientId, input.clientId), eq(table.userId, userId));
    const [consents] = await context.db.batch([
      context.db.delete(oauthConsent).where(owned(oauthConsent)).returning({ id: oauthConsent.id }),
      context.db.delete(oauthRefreshToken).where(owned(oauthRefreshToken)),
      context.db.delete(oauthAccessToken).where(owned(oauthAccessToken)),
    ]);
    if (consents.length === 0) {
      throw new ORPCError("NOT_FOUND", { message: "You have not connected that app." });
    }
    return { clientId: input.clientId };
  }),
};

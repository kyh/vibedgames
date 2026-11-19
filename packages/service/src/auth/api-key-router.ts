import { APIError } from "better-auth/api";
import { ORPCError } from "@orpc/server";

import { os, rejectApiKey, requireSession } from "../orpc";

const DAY_SECONDS = 24 * 60 * 60;

const PASSTHROUGH_API_ERROR_STATUSES = [
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "BAD_REQUEST",
  "TOO_MANY_REQUESTS",
] as const;

const sessionOnly = os.apiKeys.use(requireSession).use(rejectApiKey);

export const apiKeyRouter = {
  create: sessionOnly.create.handler(async ({ context, input }) => {
    const created = await context.auth.api.createApiKey({
      body: {
        expiresIn: input.expiresInDays === null ? null : input.expiresInDays * DAY_SECONDS,
        name: input.name,
      },
      headers: context.headers,
    });

    return {
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
      id: created.id,
      key: created.key,
      keyPrefix: created.start ?? created.prefix ?? "",
      name: created.name,
    };
  }),

  list: sessionOnly.list.handler(async ({ context }) => {
    const { apiKeys } = await context.auth.api.listApiKeys({ headers: context.headers });

    const keys = apiKeys.map((k) => ({
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      id: k.id,
      keyPrefix: k.start ?? k.prefix ?? "",
      lastUsedAt: k.lastRequest,
      name: k.name,
    }));

    return { keys };
  }),

  revoke: sessionOnly.revoke.handler(async ({ context, input }) => {
    try {
      await context.auth.api.deleteApiKey({
        body: { keyId: input.id },
        headers: context.headers,
      });

      return { id: input.id };
    } catch (error) {
      if (error instanceof APIError) {
        const status = String(error.status);
        throw new ORPCError(
          PASSTHROUGH_API_ERROR_STATUSES.find((code) => code === status) ?? "INTERNAL_SERVER_ERROR",
          { message: error.message || "Failed to revoke key" },
        );
      }

      throw error;
    }
  }),
};

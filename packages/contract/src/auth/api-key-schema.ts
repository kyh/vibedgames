import { z } from "zod";

export const createApiKeyInput = z.object({
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
  name: z.string().trim().min(1).max(100),
});

export const revokeApiKeyInput = z.object({ id: z.string() });

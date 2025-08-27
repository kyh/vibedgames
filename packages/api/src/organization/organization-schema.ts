import { z } from "zod";

export const getOrganizationInput = z.object({
  slug: z.string(),
});
export type GetOrganizationInput = z.infer<typeof getOrganizationInput>;

import { z } from "zod";

import { zJsonString } from "./utils";

export const authMetadataSchema = zJsonString.pipe(
  z.object({
    personal: z.boolean().optional(),
  }),
);
export type AuthMetadata = z.infer<typeof authMetadataSchema>;

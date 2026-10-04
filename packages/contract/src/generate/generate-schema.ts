import { z } from "zod";

export const forwardInput = z.object({
  body: z.unknown().optional(),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  // Must be a server-relative path. Empty bodies and trailing-only paths
  // are fine. We refuse anything that doesn't start with `/` so a caller
  // can't smuggle a full URL (which would change the host), and refuse
  // `?`/`#` so the path the credit classifier sees is exactly the path the
  // upstream URL gets — a `#` in the path would otherwise let a queue
  // submit reach fal while classifying (and billing) as nothing.
  path: z
    .string()
    .min(1)
    .max(512)
    .regex(/^\/[^?#]*$/u, "path must start with `/` and contain no `?` or `#`"),
  query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  target: z.enum(["queue", "platform", "storage", "docs"]),
});

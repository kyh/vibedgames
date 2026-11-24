import { z } from "zod";

const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu;

const CANONICAL_QUEUE_PATH = /^\/[a-z0-9._~/-]*$/u;

/** One raw hop to the media provider, as the typed generate procedures build it. */
export const forwardInput = z
  .object({
    body: z.unknown().optional(),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
    path: z
      .string()
      .min(1)
      .max(512)
      .regex(
        /^\/[\w.~!$&'()*+,;=:@%/-]*$/u,
        "path must start with `/` and hold only letters, digits and `-._~!$&'()*+,;=:@%/` (percent-encode anything else)",
      )
      .refine((path) => !DOT_SEGMENT.test(path), "path may not contain `.` or `..` segments"),
    query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    target: z.enum(["queue", "platform", "storage", "docs"]),
  })
  .refine((input) => input.target !== "queue" || CANONICAL_QUEUE_PATH.test(input.path), {
    message:
      "a queue path may hold only lowercase letters, digits and `-._~/`: spell the endpoint id as `vg generate models` lists it and the request id as the submit returned it",
    path: ["path"],
  });

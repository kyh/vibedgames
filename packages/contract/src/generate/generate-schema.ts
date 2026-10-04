import { z } from "zod";

// A `.` or `..` segment, spelled literally or as `%2e`, which the URL parser
// collapses.
const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu;

// The one spelling of a queue path fal routes as written. It percent-decodes
// a path and finds an application whatever its case, while the ledger
// classifies and prices the path as sent: `/fal-ai/fl%75x/dev` runs
// `fal-ai/flux` priced as an endpoint no price list names, and
// `/fal-ai/flux/%72equests/<id>` fetches a result the ledger never settles.
// The other delimiters a path may hold (`;`, `,`, `:`, `@`, ...) are refused
// with them rather than trusted to reach fal unread. Nothing real needs any of
// it: every segment of every id in fal's public catalog matches
// `[a-z0-9._~-]`, and request ids are lowercase UUIDs.
const CANONICAL_QUEUE_PATH = /^\/[a-z0-9._~/-]*$/u;

export const forwardInput = z
  .object({
    body: z.unknown().optional(),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
    // Must be a server-relative path. Empty bodies and trailing-only paths
    // are fine. We refuse anything that doesn't start with `/` so a caller
    // can't smuggle a full URL (which would change the host), and anything the
    // upstream URL (`new URL(base + path)`) would carry differently, so the path
    // the credit classifier sees is exactly the path the upstream URL gets. The
    // URL parser turns `\` into `/`, drops tabs, newlines and a trailing space,
    // collapses dot segments and percent-encodes what a path can't hold raw: so
    // `/owner\model` (or a `?`/`#`) would otherwise let a queue submit reach fal
    // while classifying (and billing) as nothing, and a `.` segment or a tab
    // would have the ledger price an endpoint other than the one fal runs. Only
    // characters the parser leaves alone are accepted; percent-encode the rest.
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
  // A queue path is the one the ledger reads, so it must be the one fal
  // routes, byte for byte. Other targets keep percent-encoding and case.
  .refine((input) => input.target !== "queue" || CANONICAL_QUEUE_PATH.test(input.path), {
    message:
      "a queue path may hold only lowercase letters, digits and `-._~/`: spell the endpoint id as `vg generate models` lists it and the request id as the submit returned it",
    path: ["path"],
  });

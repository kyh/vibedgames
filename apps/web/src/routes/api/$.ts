import { createFileRoute } from "@tanstack/react-router";

import { apiNotFound } from "@/lib/json-error";

// Without this, an unmatched `/api/*` path falls to the root catch-all and
// answers an HTML (or markdown) page to a caller that wanted JSON.
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: apiNotFound,
    },
  },
});

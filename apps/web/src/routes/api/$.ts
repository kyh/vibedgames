import { createFileRoute } from "@tanstack/react-router";

import { apiNotFound } from "@/lib/json-error";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: apiNotFound,
    },
  },
});

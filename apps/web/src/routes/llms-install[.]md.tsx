import { createFileRoute } from "@tanstack/react-router";

import { installResponse } from "@/lib/install-response";

export const Route = createFileRoute("/llms-install.md")({
  server: {
    handlers: {
      GET: () => installResponse(),
    },
  },
});

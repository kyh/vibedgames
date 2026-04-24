import { createFileRoute } from "@tanstack/react-router";

import installMd from "@/lib/install.md?raw";

const respond = () =>
  new Response(installMd, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });

export const Route = createFileRoute("/install")({
  server: {
    handlers: {
      GET: () => respond(),
    },
  },
});

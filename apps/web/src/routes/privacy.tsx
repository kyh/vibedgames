import { createFileRoute } from "@tanstack/react-router";

import { Prose } from "@/components/site/prose";
import { privacyDoc } from "@/content/privacy";
import { docHandler, docHead, varyHeaders } from "@/lib/doc-route";

export const Route = createFileRoute("/privacy")({
  server: { handlers: { GET: docHandler(privacyDoc) } },
  headers: varyHeaders(),
  head: () => docHead(privacyDoc),
  component: () => <Prose doc={privacyDoc} />,
});

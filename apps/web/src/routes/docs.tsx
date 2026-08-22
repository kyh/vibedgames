import { createFileRoute } from "@tanstack/react-router";

import { Prose } from "@/components/site/prose";
import { docsDoc } from "@/content/docs";
import { docHandler, docHead, varyHeaders } from "@/lib/doc-route";

export const Route = createFileRoute("/docs")({
  server: { handlers: { GET: docHandler(docsDoc) } },
  headers: varyHeaders(),
  head: () => docHead(docsDoc),
  component: () => <Prose doc={docsDoc} />,
});

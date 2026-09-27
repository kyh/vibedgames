import { createFileRoute } from "@tanstack/react-router";

import { Prose } from "@/components/site/prose";
import { contactDoc } from "@/content/contact";
import { docHandler, docHead, varyHeaders } from "@/lib/doc-route";

export const Route = createFileRoute("/contact")({
  component: () => <Prose doc={contactDoc} />,
  head: () => docHead(contactDoc),
  headers: varyHeaders(),
  server: { handlers: { GET: docHandler(contactDoc) } },
});

import { createFileRoute } from "@tanstack/react-router";

import { Prose } from "@/components/site/prose";
import { contactDoc } from "@/content/contact";
import { docHandler, docHead, varyHeaders } from "@/lib/doc-route";

export const Route = createFileRoute("/contact")({
  server: { handlers: { GET: docHandler(contactDoc) } },
  headers: varyHeaders(),
  head: () => docHead(contactDoc),
  component: () => <Prose doc={contactDoc} />,
});

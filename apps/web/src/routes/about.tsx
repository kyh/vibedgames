import { createFileRoute } from "@tanstack/react-router";

import { Prose } from "@/components/site/prose";
import { aboutDoc } from "@/content/about";
import { docHandler, docHead, varyHeaders } from "@/lib/doc-route";

export const Route = createFileRoute("/about")({
  server: { handlers: { GET: docHandler(aboutDoc) } },
  headers: varyHeaders(),
  head: () => docHead(aboutDoc),
  component: () => <Prose doc={aboutDoc} />,
});

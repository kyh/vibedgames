import { createFileRoute } from "@tanstack/react-router";

import { LegalPage } from "@/components/legal/legal-page";
import { termsDoc } from "@/content/terms";
import { docHandler, docHead, varyHeaders } from "@/lib/doc-route";

export const Route = createFileRoute("/terms")({
  component: () => <LegalPage doc={termsDoc} />,
  head: () => docHead(termsDoc),
  headers: varyHeaders(),
  server: { handlers: { GET: docHandler(termsDoc) } },
});

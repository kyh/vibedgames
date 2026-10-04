import { createFileRoute } from "@tanstack/react-router";

import { LegalPage } from "@/components/legal/legal-page";
import { privacyDoc } from "@/content/privacy";
import { docHandler, docHead, varyHeaders } from "@/lib/doc-route";

export const Route = createFileRoute("/privacy")({
  component: () => <LegalPage doc={privacyDoc} />,
  head: () => docHead(privacyDoc),
  headers: varyHeaders(),
  server: { handlers: { GET: docHandler(privacyDoc) } },
});

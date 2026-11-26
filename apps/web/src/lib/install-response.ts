import { mergeHeaders } from "@/lib/content-negotiation";
import installMd from "@/lib/install.md?raw";

/**
 * `/install`, `/llms.txt` and the AI-crawler view of `/` all serve the same
 * markdown. Callers that reach it through content negotiation pass their own
 * `Vary` — see `lib/content-negotiation`.
 */
export const installResponse = (init: ResponseInit = {}) =>
  new Response(installMd, {
    ...init,
    headers: mergeHeaders(
      { "Cache-Control": "public, max-age=300", "Content-Type": "text/markdown; charset=utf-8" },
      init.headers,
    ),
  });

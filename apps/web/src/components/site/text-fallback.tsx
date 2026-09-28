import type { Doc } from "@/lib/doc";
import { Blocks } from "@/components/site/prose";

/**
 * The server-rendered text representation of a canvas- or image-only page.
 *
 * `/` and `/discover` are pictures: with JavaScript off they are empty
 * documents, and with JavaScript on they announce almost nothing to a screen
 * reader. This supplies both audiences without touching the visual design.
 *
 * - The heading and lead are `sr-only`: in the SSR HTML, read by assistive
 *   tech, invisible on screen — until a keyboard user tabs onto a link in the
 *   lead, when the block shows itself like a skip link rather than moving
 *   focus somewhere invisible.
 * - The link-bearing sections live in `<noscript>`, so a crawler that never
 *   runs JavaScript can still walk the site while a sighted keyboard user
 *   never tabs into an invisible link.
 *
 * Both halves render the same {@link Doc} the page serves to a client
 * negotiating `Accept: text/markdown` — one source, three renderings.
 */
export const TextFallback = ({ doc, note }: { doc: Doc; note?: string }) => (
  <>
    <div className="sr-only focus-within:not-sr-only focus-within:fixed focus-within:inset-x-4 focus-within:top-4 focus-within:z-50 focus-within:space-y-2 focus-within:rounded-md focus-within:bg-background focus-within:p-4 focus-within:text-sm">
      <h1>{doc.title}</h1>
      <p>{doc.description}</p>
      <Blocks blocks={doc.lead} />
    </div>
    <noscript>
      <div className="mx-auto max-w-2xl space-y-6 p-6 text-sm">
        {note && <p>{note}</p>}
        {doc.sections.map((section) => (
          <section key={section.heading} className="space-y-3">
            <h2 className="font-medium">{section.heading}</h2>
            <Blocks blocks={section.blocks} />
          </section>
        ))}
      </div>
    </noscript>
  </>
);

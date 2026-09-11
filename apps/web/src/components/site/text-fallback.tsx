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
 *   tech, invisible on screen.
 * - The link-bearing sections live in `<noscript>`, so a crawler that never
 *   runs JavaScript can still walk the site while a sighted keyboard user
 *   never tabs into an invisible link.
 *
 * Both halves render the same {@link Doc} the page serves to a client
 * negotiating `Accept: text/markdown` — one source, three renderings.
 */
export const TextFallback = ({ doc, note }: { doc: Doc; note?: string }) => (
  <>
    <div className="sr-only">
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

import { Link } from "@tanstack/react-router";

import type { Doc } from "@/lib/doc";
import { Blocks, SectionHeading, SiteLinks } from "@/components/site/prose";
import { siteConfig } from "@/lib/site-config";

/**
 * The Privacy Policy and the Terms of Use, rendered from their {@link Doc}.
 * The same `Doc` is what `Accept: text/markdown` gets, so the HTML and the
 * markdown say the same thing word for word. Unlike `Prose`, the description
 * stays out of the page (it is the meta description and the markdown summary)
 * and the site links sit in an `sr-only` nav, as they always have here.
 */
export const LegalPage = ({ doc }: { doc: Doc }) => (
  <>
    <main className="mx-auto w-full max-w-2xl px-4 py-16 sm:py-24">
      <Link to="/" className="text-muted-foreground font-mono text-xs hover:text-foreground">
        ← {siteConfig.name.toLowerCase()}
      </Link>
      <h1 className="mt-6 text-3xl font-medium leading-[0.9] -tracking-[0.03em] sm:text-5xl">
        {doc.title}
      </h1>
      <div className="mt-10 flex flex-col gap-10 text-sm leading-relaxed text-pretty [&_code]:whitespace-nowrap">
        <div className="flex flex-col gap-3">
          <Blocks blocks={doc.lead} />
        </div>
        {doc.sections.map((section) => (
          <section key={section.heading} className="flex flex-col gap-3">
            <SectionHeading heading={section.heading} />
            <Blocks blocks={section.blocks} />
          </section>
        ))}
        {doc.endnote && (
          <div className="flex flex-col gap-3">
            <hr className="border-dashed" />
            <Blocks blocks={doc.endnote} />
          </div>
        )}
      </div>
    </main>
    <nav className="sr-only">
      <SiteLinks current={doc.path} tabIndex={-1} />
    </nav>
  </>
);

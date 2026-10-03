import { Link } from "@tanstack/react-router";
import { useId } from "react";

import type { Block, Doc, InlineNode } from "@/lib/doc";
import { headingId, parseInline } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

/** A site path or a `#fragment` on this page: no `rel`, same tab. */
const isInternal = (href: string) => href.startsWith("/") || href.startsWith("#");

const LINK_CLASS = "text-foreground underline underline-offset-4";

/**
 * `tabIndex` is for text that is in the DOM for crawlers and screen readers
 * but not on screen: `-1` keeps its links out of the keyboard tab order, so
 * focus never lands on something invisible.
 */
interface Focus {
  tabIndex?: number;
}

const InlineLink = ({ node, tabIndex }: Focus & { node: Extract<InlineNode, { kind: "link" }> }) =>
  isInternal(node.href) ? (
    <a href={node.href} tabIndex={tabIndex} className={LINK_CLASS}>
      {node.text}
    </a>
  ) : (
    <a href={node.href} rel="noopener noreferrer" tabIndex={tabIndex} className={LINK_CLASS}>
      {node.text}
    </a>
  );

const Inline = ({ nodes, tabIndex }: Focus & { nodes: InlineNode[] }) => (
  <>
    {nodes.map((node, key) => {
      if (node.kind === "strong") {
        return (
          <strong key={key} className="text-foreground font-medium">
            {node.text}
          </strong>
        );
      }
      if (node.kind === "code") {
        return (
          <code key={key} className="bg-input/40 rounded px-1 py-0.5 font-mono text-[0.9em]">
            {node.text}
          </code>
        );
      }
      if (node.kind === "link") {
        return <InlineLink key={key} node={node} tabIndex={tabIndex} />;
      }
      return <span key={key}>{node.text}</span>;
    })}
  </>
);

const Text = ({ text, tabIndex }: Focus & { text: string }) => (
  <Inline nodes={parseInline(text)} tabIndex={tabIndex} />
);

/**
 * Wide tables scroll inside their own box, so a narrow screen never scrolls
 * the whole page sideways to read one. The box is a named, focusable region,
 * so a keyboard can scroll it too; a row's first cell names the row.
 */
const Table = ({ block, tabIndex }: Focus & { block: Extract<Block, { kind: "table" }> }) => {
  const captionId = useId();
  return (
    <section aria-labelledby={captionId} tabIndex={tabIndex ?? 0} className="overflow-x-auto">
      <table className="text-muted-foreground w-full min-w-[32rem] border-collapse text-left text-xs leading-relaxed">
        <caption id={captionId} className="sr-only">
          {block.caption}
        </caption>
        <thead>
          <tr className="border-b">
            {block.head.map((cell, j) => (
              <th key={j} scope="col" className="text-foreground p-2 align-bottom font-medium">
                <Text text={cell} tabIndex={tabIndex} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, i) => (
            <tr key={i} className="border-b border-dashed last:border-0">
              {row.map((cell, j) =>
                j === 0 ? (
                  <th
                    key={j}
                    scope="row"
                    className="text-foreground p-2 text-left align-top font-medium"
                  >
                    <Text text={cell} tabIndex={tabIndex} />
                  </th>
                ) : (
                  <td key={j} className="p-2 align-top">
                    <Text text={cell} tabIndex={tabIndex} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

/** A section's `<h2>`, anchored by {@link headingId} so `#fragment` links land on it. */
export const SectionHeading = ({ heading }: { heading: string }) => (
  <h2 id={headingId(heading)} className="scroll-mt-6 text-lg font-medium -tracking-[0.02em]">
    {heading}
  </h2>
);

export const Blocks = ({ blocks, tabIndex }: Focus & { blocks: Block[] }) => (
  <>
    {blocks.map((block, key) => {
      if (block.kind === "p") {
        return (
          <p key={key} className="text-muted-foreground leading-relaxed">
            <Text text={block.text} tabIndex={tabIndex} />
          </p>
        );
      }
      if (block.kind === "ul") {
        return (
          <ul key={key} className="text-muted-foreground list-disc space-y-2 pl-5 leading-relaxed">
            {block.items.map((item, j) => (
              <li key={j}>
                <Text text={item} tabIndex={tabIndex} />
              </li>
            ))}
          </ul>
        );
      }
      if (block.kind === "table") {
        return <Table key={key} block={block} tabIndex={tabIndex} />;
      }
      return (
        <pre
          key={key}
          className="bg-input/40 overflow-x-auto rounded-md p-4 font-mono text-xs leading-relaxed"
        >
          <code>{block.code}</code>
        </pre>
      );
    })}
  </>
);

const FOOTER_LINKS = [
  { label: "Play", to: "/" },
  { label: "Discover", to: "/discover" },
  { label: "Build", to: "/build" },
  { label: "Docs", to: "/docs" },
  { label: "About", to: "/about" },
  { label: "Contact", to: "/contact" },
  { label: "Privacy", to: "/privacy" },
  { label: "Terms", to: "/terms" },
] as const;

/**
 * Every top-level page, plus the two agent entry points. `current` is left out
 * so a page never links to itself.
 */
export const SiteLinks = ({ current, tabIndex }: Focus & { current: string }) => (
  <>
    {FOOTER_LINKS.filter((link) => link.to !== current).map((link) => (
      <Link
        key={link.to}
        to={link.to}
        tabIndex={tabIndex}
        className="hover:text-foreground transition-colors"
      >
        {link.label}
      </Link>
    ))}
    <a href="/llms.txt" tabIndex={tabIndex} className="hover:text-foreground transition-colors">
      llms.txt
    </a>
    <a
      href={siteConfig.repository}
      rel="noopener noreferrer"
      tabIndex={tabIndex}
      className="hover:text-foreground transition-colors"
    >
      GitHub
    </a>
  </>
);

/**
 * Renders a {@link Doc} as the HTML representation of a prose page. The same
 * `Doc` is serialized to markdown for `Accept: text/markdown`, so the two can
 * never disagree about what the page says.
 */
export const Prose = ({ doc }: { doc: Doc }) => (
  <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-10 px-4 py-16 text-sm sm:py-24">
    <header className="space-y-4">
      <Link to="/" className="text-muted-foreground hover:text-foreground font-mono text-xs">
        ← {siteConfig.name}
      </Link>
      <h1 className="mt-6 text-3xl font-medium leading-[0.9] -tracking-[0.03em] sm:text-5xl">
        {doc.title}
      </h1>
      <p className="text-muted-foreground leading-relaxed">
        <Text text={doc.description} />
      </p>
    </header>

    {doc.lead.length > 0 && (
      <div className="space-y-4">
        <Blocks blocks={doc.lead} />
      </div>
    )}

    {doc.sections.map((section) => (
      <section key={section.heading} className="space-y-4">
        <SectionHeading heading={section.heading} />
        <Blocks blocks={section.blocks} />
      </section>
    ))}

    {doc.endnote && (
      <div className="space-y-4">
        <hr className="border-dashed" />
        <Blocks blocks={doc.endnote} />
      </div>
    )}

    <footer className="text-muted-foreground mt-auto flex flex-wrap gap-x-4 gap-y-2 border-t border-dashed pt-6 font-mono text-xs">
      <SiteLinks current={doc.path} />
    </footer>
  </main>
);

import { Link } from "@tanstack/react-router";

import type { Block, Doc, InlineNode } from "@/lib/doc";
import { parseInline } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

const isInternal = (href: string) => href.startsWith("/");

const Inline = ({ nodes }: { nodes: InlineNode[] }) => (
  <>
    {nodes.map((node, i) => {
      switch (node.kind) {
        case "text":
          return <span key={i}>{node.text}</span>;
        case "strong":
          return (
            <strong key={i} className="text-foreground font-medium">
              {node.text}
            </strong>
          );
        case "code":
          return (
            <code key={i} className="bg-input/40 rounded px-1 py-0.5 font-mono text-[0.9em]">
              {node.text}
            </code>
          );
        case "link":
          return isInternal(node.href) ? (
            <a key={i} href={node.href} className="text-foreground underline underline-offset-4">
              {node.text}
            </a>
          ) : (
            <a
              key={i}
              href={node.href}
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4"
            >
              {node.text}
            </a>
          );
      }
    })}
  </>
);

const Text = ({ text }: { text: string }) => <Inline nodes={parseInline(text)} />;

export const Blocks = ({ blocks }: { blocks: Block[] }) => (
  <>
    {blocks.map((block, i) => {
      switch (block.kind) {
        case "p":
          return (
            <p key={i} className="text-muted-foreground leading-relaxed">
              <Text text={block.text} />
            </p>
          );
        case "ul":
          return (
            <ul key={i} className="text-muted-foreground list-disc space-y-2 pl-5 leading-relaxed">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Text text={item} />
                </li>
              ))}
            </ul>
          );
        case "code":
          return (
            <pre
              key={i}
              className="bg-input/40 overflow-x-auto rounded-md p-4 font-mono text-xs leading-relaxed"
            >
              <code>{block.code}</code>
            </pre>
          );
      }
    })}
  </>
);

const FOOTER_LINKS = [
  { to: "/", label: "Play" },
  { to: "/discover", label: "Discover" },
  { to: "/build", label: "Build" },
  { to: "/docs", label: "Docs" },
  { to: "/about", label: "About" },
  { to: "/contact", label: "Contact" },
  { to: "/privacy", label: "Privacy" },
] as const;

/**
 * Renders a {@link Doc} as the HTML representation of a prose page. The same
 * `Doc` is serialized to markdown for `Accept: text/markdown`, so the two can
 * never disagree about what the page says.
 */
export const Prose = ({ doc }: { doc: Doc }) => (
  <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-10 px-6 py-16 text-sm">
    <header className="space-y-4">
      <Link to="/" className="text-muted-foreground hover:text-foreground font-mono text-xs">
        ← {siteConfig.name}
      </Link>
      <h1 className="text-3xl font-medium leading-[0.95] -tracking-[0.03em] sm:text-4xl">
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
        <h2 className="text-lg font-medium -tracking-[0.02em]">{section.heading}</h2>
        <Blocks blocks={section.blocks} />
      </section>
    ))}

    <footer className="text-muted-foreground mt-auto flex flex-wrap gap-x-4 gap-y-2 border-t border-dashed pt-6 font-mono text-xs">
      {FOOTER_LINKS.filter((link) => link.to !== doc.path).map((link) => (
        <Link key={link.to} to={link.to} className="hover:text-foreground transition-colors">
          {link.label}
        </Link>
      ))}
      <a href="/llms.txt" className="hover:text-foreground transition-colors">
        llms.txt
      </a>
      <a
        href={siteConfig.repository}
        rel="noopener noreferrer"
        className="hover:text-foreground transition-colors"
      >
        GitHub
      </a>
    </footer>
  </main>
);

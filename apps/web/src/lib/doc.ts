/**
 * A tiny structured document model.
 *
 * Every prose page on the apex domain is authored once as a `Doc` and rendered
 * twice: as HTML for browsers ({@link ../components/site/prose}) and as
 * markdown for agents that negotiate `Accept: text/markdown`. Authoring the
 * content in one place is what keeps the two representations honest — a
 * hand-maintained markdown mirror drifts the first time someone edits a page.
 *
 * Inline links use markdown syntax (`[label](href)`) in `text`, so the
 * markdown serializer is a straight passthrough and only the HTML renderer has
 * to parse anything.
 */

import { siteConfig } from "@/lib/site-config";

export type Block =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "code"; lang?: string; code: string };

export interface Section {
  heading: string;
  blocks: Block[];
}

export interface Doc {
  /** Absolute path this doc is served at, e.g. `/about`. */
  path: string;
  /** `<h1>` and markdown `#` heading. */
  title: string;
  /** `<meta name="description">` and the markdown lead blockquote. */
  description: string;
  /** Blocks before the first section heading. */
  lead: Block[];
  sections: Section[];
}

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

/** `[label](href)`, `**bold**`, `` `code` `` — the only inline syntax we author. */
const INLINE =
  /\[(?<label>[^\]]+)\]\((?<href>[^)\s]+)\)|\*\*(?<strong>[^*]+)\*\*|`(?<code>[^`]+)`/gu;

const inlineNode = (groups: Record<string, string | undefined>): InlineNode | null => {
  if (groups.label !== undefined) {
    return { href: groups.href ?? "", kind: "link", text: groups.label };
  }
  if (groups.strong !== undefined) {
    return { kind: "strong", text: groups.strong };
  }
  if (groups.code !== undefined) {
    return { kind: "code", text: groups.code };
  }
  return null;
};

/** Split `text` into plain runs, links, bold runs and inline code, in order. */
export const parseInline = (text: string): InlineNode[] => {
  const nodes: InlineNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) {
      nodes.push({ kind: "text", text: text.slice(last, match.index) });
    }
    const node = inlineNode(match.groups ?? {});
    if (node) {
      nodes.push(node);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push({ kind: "text", text: text.slice(last) });
  }
  return nodes;
};

/**
 * Site-relative links become absolute in the markdown representation. An agent
 * that fetched the markdown has no document base to resolve `/docs` against —
 * it may be reading the body far from the request that produced it.
 */
const absolutize = (text: string, baseUrl: string): string =>
  text.replaceAll(/\]\(\/(?!\/)/gu, `](${baseUrl}/`);

const blockToMarkdown = (block: Block, baseUrl: string): string => {
  if (block.kind === "p") {
    return absolutize(block.text, baseUrl);
  }
  if (block.kind === "ul") {
    return block.items.map((item) => `- ${absolutize(item, baseUrl)}`).join("\n");
  }
  return [`\`\`\`${block.lang ?? ""}`, block.code, "```"].join("\n");
};

/** Serialize a doc to CommonMark, with site-relative links made absolute. */
export const docToMarkdown = (doc: Doc, baseUrl: string = siteConfig.url): string => {
  const parts: string[] = [`# ${doc.title}`, `> ${absolutize(doc.description, baseUrl)}`];
  for (const block of doc.lead) {
    parts.push(blockToMarkdown(block, baseUrl));
  }
  for (const section of doc.sections) {
    parts.push(`## ${section.heading}`);
    for (const block of section.blocks) {
      parts.push(blockToMarkdown(block, baseUrl));
    }
  }
  return `${parts.join("\n\n")}\n`;
};

/** Plain text of a doc, for length assertions and content-efficiency checks. */
export const docToText = (doc: Doc): string => {
  const strip = (text: string) =>
    parseInline(text)
      .map((node) => node.text)
      .join("");
  const parts: string[] = [doc.title, strip(doc.description)];
  const push = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.kind === "p") {
        parts.push(strip(block.text));
      }
      if (block.kind === "ul") {
        parts.push(...block.items.map(strip));
      }
      if (block.kind === "code") {
        parts.push(block.code);
      }
    }
  };
  push(doc.lead);
  for (const section of doc.sections) {
    parts.push(section.heading);
    push(section.blocks);
  }
  return parts.join("\n\n");
};

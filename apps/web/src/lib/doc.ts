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

/**
 * Table cells are inline text like any other block's, one row per array; a
 * cell holds no line break, because a GFM pipe-table row cannot. A table's
 * `caption` names it to assistive tech; a GFM table has no caption, so the
 * markdown leans on the paragraph that introduces it.
 */
export type Block =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "table"; caption: string; head: string[]; rows: string[][] }
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
  /**
   * Blocks after the last section, set off by a rule: a credit or footnote
   * that belongs to no one section.
   */
  endnote?: Block[];
}

/** Block constructors, for docs long enough that object literals bury the text. */
export const p = (text: string): Block => ({ kind: "p", text });
export const ul = (...items: string[]): Block => ({ items, kind: "ul" });
export const table = (caption: string, head: string[], ...rows: string[][]): Block => ({
  caption,
  head,
  kind: "table",
  rows,
});

/**
 * The anchor id of a section heading, by GitHub's heading-slug rule
 * (lowercased, punctuation dropped, every space a hyphen), so a `#fragment`
 * link resolves to the same heading in the HTML page and wherever its
 * markdown is rendered.
 */
export const headingId = (heading: string): string =>
  heading
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{M}\p{N} _-]/gu, "")
    .replaceAll(" ", "-");

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

/** One GFM pipe-table row. A literal `|` in a cell would end the cell early. */
const tableRow = (cells: string[], baseUrl: string): string =>
  `| ${cells.map((cell) => absolutize(cell, baseUrl).replaceAll("|", String.raw`\|`)).join(" | ")} |`;

const blockToMarkdown = (block: Block, baseUrl: string): string => {
  if (block.kind === "p") {
    return absolutize(block.text, baseUrl);
  }
  if (block.kind === "ul") {
    return block.items.map((item) => `- ${absolutize(item, baseUrl)}`).join("\n");
  }
  if (block.kind === "table") {
    return [
      tableRow(block.head, baseUrl),
      `| ${block.head.map(() => "---").join(" | ")} |`,
      ...block.rows.map((row) => tableRow(row, baseUrl)),
    ].join("\n");
  }
  return [`\`\`\`${block.lang ?? ""}`, block.code, "```"].join("\n");
};

/**
 * Serialize a doc to CommonMark (plus GFM tables), with site-relative links
 * made absolute. `#fragment` links stay relative: they point into this same
 * document, at the heading slugs a GFM renderer generates.
 */
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
  if (doc.endnote) {
    parts.push("---");
    for (const block of doc.endnote) {
      parts.push(blockToMarkdown(block, baseUrl));
    }
  }
  return `${parts.join("\n\n")}\n`;
};

const stripInline = (text: string) =>
  parseInline(text)
    .map((node) => node.text)
    .join("");

/** Plain text of a doc, for length assertions and content-efficiency checks. */
export const docToText = (doc: Doc): string => {
  const parts: string[] = [doc.title, stripInline(doc.description)];
  const push = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.kind === "p") {
        parts.push(stripInline(block.text));
      }
      if (block.kind === "ul") {
        parts.push(...block.items.map(stripInline));
      }
      if (block.kind === "table") {
        parts.push(...[block.head, ...block.rows].map((row) => row.map(stripInline).join("\t")));
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
  push(doc.endnote ?? []);
  return parts.join("\n\n");
};

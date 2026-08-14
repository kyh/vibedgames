/**
 * A minimal YAML reader for SKILL.md frontmatter.
 *
 * Only the subset frontmatter actually uses is supported: flat `key: value`
 * pairs, quoted strings, inline `[a, b]` lists, booleans/numbers/null, and one
 * level of nested mapping (which is all `metadata` ever holds). Folded and
 * literal block scalars (`>` / `|`) are deliberately *not* supported — the
 * validator rejects them anyway, because strict frontmatter parsers elsewhere
 * in the toolchain choke on them.
 *
 * This exists so skill tooling needs no PyYAML. The Python scripts imported it
 * without declaring it, so `python3 quick_validate.py` failed outright unless
 * the system Python happened to have PyYAML installed.
 */

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

/** Strip a trailing `#` comment that sits outside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text === "") return "";
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    const body = text.slice(1, -1);
    // Only double quotes process escapes, as in YAML.
    return text[0] === '"' ? body.replaceAll(String.raw`\"`, '"').replaceAll("\\n", "\n") : body;
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item));
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

/** Parse frontmatter YAML into an object. Throws `FrontmatterError` on input
 * this subset cannot represent, rather than silently returning something wrong. */
export function parseFrontmatter(text: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  let currentKey: string | null = null;
  let nested: Record<string, YamlValue> | null = null;

  for (const rawLine of text.split("\n")) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;

    const indented = /^\s/.test(line);
    if (indented) {
      if (!nested || currentKey === null) {
        throw new FrontmatterError(`unexpected indented line: ${rawLine.trim()}`);
      }
      const match = /^\s+([^:]+):\s*(.*)$/.exec(line);
      if (!match) throw new FrontmatterError(`could not parse nested line: ${rawLine.trim()}`);
      nested[match[1]!.trim()] = parseScalar(match[2]!);
      continue;
    }

    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) throw new FrontmatterError(`could not parse line: ${rawLine.trim()}`);
    const key = match[1]!.trim();
    const value = match[2]!;

    if (value.trim() === "") {
      // A bare `key:` opens a nested mapping (or is an empty value if nothing
      // indented follows, which resolves to an empty object either way).
      currentKey = key;
      nested = {};
      out[key] = nested;
    } else {
      currentKey = null;
      nested = null;
      out[key] = parseScalar(value);
    }
  }
  return out;
}

export type SplitSkill = {
  frontmatterText: string;
  frontmatter: Record<string, YamlValue>;
  body: string;
};

/**
 * Split a SKILL.md into its frontmatter and body. Returns null when the file
 * has no `---` delimited frontmatter at all.
 */
export function splitSkill(content: string): SplitSkill | null {
  if (!content.startsWith("---")) return null;
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return null;
  const frontmatterText = match[1]!;
  return {
    frontmatterText,
    frontmatter: parseFrontmatter(frontmatterText),
    body: content.slice(match[0].length).replace(/^\n/, ""),
  };
}

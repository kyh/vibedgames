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
const stripComment = (line: string): string => {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/u.test(line.charAt(i - 1)))) {
      return line.slice(0, i);
    }
  }
  return line;
};

const parseScalar = (raw: string): YamlValue => {
  const text = raw.trim();
  if (text === "") {
    return "";
  }
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
    if (!inner) {
      return [];
    }
    return inner.split(",").map((item) => parseScalar(item));
  }
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  if (text === "null" || text === "~") {
    return null;
  }
  if (/^-?\d+$/u.test(text)) {
    return Math.trunc(Number(text));
  }
  if (/^-?\d*\.\d+$/u.test(text)) {
    return Number(text);
  }
  return text;
};

/**
 * Join the lines of a block scalar the way YAML does.
 *
 * `|` keeps the newlines, `>` folds each run of them into a single space but
 * keeps a blank line as a real break. A trailing `-` strips the final newline.
 */
const joinBlockScalar = (lines: string[], style: string): string => {
  const indent = lines.find((l) => l.trim())?.match(/^\s*/u)?.[0].length ?? 0;
  const stripped = lines.map((l) => l.slice(indent));
  const literal = style.startsWith("|");

  let text = "";
  if (literal) {
    text = stripped.join("\n");
  } else {
    for (const [i, line] of stripped.entries()) {
      if (i === 0) {
        text = line;
      } else if (line.trim() === "" || (stripped[i - 1] ?? "").trim() === "") {
        text += `\n${line}`;
      } else {
        text += ` ${line}`;
      }
    }
  }
  text = text.replace(/\s+$/u, "");
  return style.endsWith("-") ? text : `${text}\n`;
};

const NESTED_LINE_RE = /^\s+(?<key>[^:]+):\s*(?<value>.*)$/u;
const LINE_RE = /^(?<key>[^:]+):\s*(?<value>.*)$/u;
const BLOCK_SCALAR_RE = /^(?<style>[|>])(?<chomp>[+-]?)$/u;

const splitKeyValue = (re: RegExp, line: string): { key: string; value: string } | null => {
  const groups = re.exec(line)?.groups;
  if (!groups) {
    return null;
  }
  return { key: (groups.key ?? "").trim(), value: groups.value ?? "" };
};

/** Parse frontmatter YAML into an object. Throws `FrontmatterError` on input
 * this subset cannot represent, rather than silently returning something wrong. */
export const parseFrontmatter = (text: string) => {
  const out: Record<string, YamlValue> = {};
  let currentKey: string | null = null;
  let nested: Record<string, YamlValue> | null = null;

  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i] ?? "";
    const line = stripComment(rawLine);
    if (!line.trim()) {
      continue;
    }

    const indented = /^\s/u.test(line);
    if (indented) {
      if (!nested || currentKey === null) {
        throw new FrontmatterError(`unexpected indented line: ${rawLine.trim()}`);
      }
      const pair = splitKeyValue(NESTED_LINE_RE, line);
      if (!pair) {
        throw new FrontmatterError(`could not parse nested line: ${rawLine.trim()}`);
      }
      nested[pair.key] = parseScalar(pair.value);
      continue;
    }

    const pair = splitKeyValue(LINE_RE, line);
    if (!pair) {
      throw new FrontmatterError(`could not parse line: ${rawLine.trim()}`);
    }
    const { key, value } = pair;

    // `key: >` / `key: |` opens a block scalar: every following line indented
    // under it is its text, taken verbatim — a `#` in prose is not a comment.
    const block = BLOCK_SCALAR_RE.exec(value.trim())?.groups;
    if (block) {
      const body: string[] = [];
      for (;;) {
        const next = rawLines[i + 1];
        if (next === undefined || (next.trim() !== "" && !/^\s/u.test(next))) {
          break;
        }
        body.push(next);
        i += 1;
      }
      while (body.at(-1)?.trim() === "") {
        body.pop();
      }
      currentKey = null;
      nested = null;
      out[key] = joinBlockScalar(body, `${block.style ?? ""}${block.chomp ?? ""}`);
      continue;
    }

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
};

export interface SplitSkill {
  frontmatterText: string;
  frontmatter: Record<string, YamlValue>;
  body: string;
}

/**
 * Split a SKILL.md into its frontmatter and body. Returns null when the file
 * has no `---` delimited frontmatter at all.
 */
export const splitSkill = (content: string): SplitSkill | null => {
  if (!content.startsWith("---")) {
    return null;
  }
  const match = /^---\n(?<front>[\s\S]*?)\n---/u.exec(content);
  if (!match) {
    return null;
  }
  const frontmatterText = match.groups?.front ?? "";
  return {
    body: content.slice(match[0].length).replace(/^\n/u, ""),
    frontmatter: parseFrontmatter(frontmatterText),
    frontmatterText,
  };
};

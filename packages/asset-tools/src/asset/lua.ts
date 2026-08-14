/**
 * A small reader for Lua table literals, enough to load an `assets_index.lua`
 * manifest without a Lua runtime. Ported from the dependency-free Python
 * parser the asset-pipeline skill shipped, keeping its grammar and its error
 * messages so failures read the same way.
 *
 * Handles: `return`-prefixed tables, `key = value` and `[expr] = value` pairs,
 * positional array items, strings with escapes, numbers, booleans, `nil`, and
 * both line and long-bracket comments.
 */

export class LuaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LuaParseError";
  }
}

export type LuaValue = string | number | boolean | null | LuaValue[] | { [key: string]: LuaValue };

type TokenType = "{" | "}" | "[" | "]" | "=" | "," | ";" | "string" | "number" | "ident" | "eof";
type Token = { type: TokenType; value: string; pos: number };

const IDENT_START = /[A-Za-z_]/;
const IDENT_BODY = /[A-Za-z0-9_]/;
const PUNCTUATION = new Set(["{", "}", "[", "]", "=", ",", ";"]);

function isSpace(ch: string): boolean {
  return ch !== "" && /\s/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const peek = (n = 0) => (i + n < text.length ? text[i + n]! : "");

  const skipTrivia = () => {
    for (;;) {
      while (isSpace(peek())) i += 1;
      if (peek() !== "-" || peek(1) !== "-") return;
      i += 2;
      if (peek() === "[" && peek(1) === "[") {
        i += 2;
        const end = text.indexOf("]]", i);
        // An unterminated long comment swallows the rest of the file, which
        // is what the Lua lexer itself does.
        i = end === -1 ? text.length : end + 2;
      } else {
        while (peek() !== "" && peek() !== "\n") i += 1;
      }
    }
  };

  for (;;) {
    skipTrivia();
    if (i >= text.length) {
      tokens.push({ type: "eof", value: "", pos: i });
      return tokens;
    }

    const ch = peek();
    const pos = i;

    if (PUNCTUATION.has(ch)) {
      tokens.push({ type: ch as TokenType, value: ch, pos });
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      const out: string[] = [];
      for (;;) {
        const c = peek();
        if (c === "") throw new LuaParseError("Unterminated string");
        if (c === quote) {
          i += 1;
          break;
        }
        if (c === "\\") {
          i += 1;
          const esc = peek();
          if (esc === "n") out.push("\n");
          else if (esc === "t") out.push("\t");
          else if (esc === "r") out.push("\r");
          else if (esc === '"' || esc === "'" || esc === "\\") out.push(esc);
          // Unknown escapes are preserved verbatim rather than dropped, so a
          // Windows path in a manifest survives the round trip.
          else out.push(`\\${esc}`);
          if (esc !== "") i += 1;
          continue;
        }
        out.push(c);
        i += 1;
      }
      tokens.push({ type: "string", value: out.join(""), pos });
      continue;
    }

    if (isDigit(ch) || (ch === "-" && isDigit(peek(1)))) {
      let j = ch === "-" ? i + 1 : i;
      while (j < text.length && (isDigit(text[j]!) || text[j] === ".")) j += 1;
      tokens.push({ type: "number", value: text.slice(i, j), pos });
      i = j;
      continue;
    }

    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < text.length && IDENT_BODY.test(text[j]!)) j += 1;
      tokens.push({ type: "ident", value: text.slice(i, j), pos });
      i = j;
      continue;
    }

    throw new LuaParseError(`Unexpected character at ${pos}: '${ch}'`);
  }
}

/** Parse a Lua table literal (optionally `return`-prefixed) into JSON data. */
export function parseLua(text: string): LuaValue {
  const tokens = tokenize(text);
  let k = 0;

  const cur = () => tokens[k]!;
  const peek = (n = 1) => tokens[Math.min(k + n, tokens.length - 1)]!;
  const eat = (type?: TokenType) => {
    const token = cur();
    if (type !== undefined && token.type !== type) {
      throw new LuaParseError(`Expected ${type}, got ${token.type} at ${token.pos}`);
    }
    k += 1;
    return token;
  };

  const parseValue = (): LuaValue => {
    const token = cur();
    if (token.type === "{") return parseTable();
    if (token.type === "string") {
      eat("string");
      return token.value;
    }
    if (token.type === "number") {
      eat("number");
      return token.value.includes(".")
        ? Number.parseFloat(token.value)
        : Number.parseInt(token.value, 10);
    }
    if (token.type === "ident") {
      if (token.value === "true") {
        eat("ident");
        return true;
      }
      if (token.value === "false") {
        eat("ident");
        return false;
      }
      if (token.value === "nil") {
        eat("ident");
        return null;
      }
      throw new LuaParseError(`Unsupported identifier value at ${token.pos}: '${token.value}'`);
    }
    throw new LuaParseError(`Unexpected token at ${token.pos}: ${token.type}`);
  };

  const parseTable = (): LuaValue => {
    eat("{");
    const items: [string | number, LuaValue][] = [];
    let arrayIndex = 1;

    while (cur().type !== "}") {
      if (cur().type === "ident" && peek().type === "=") {
        const key = eat("ident").value;
        eat("=");
        items.push([key, parseValue()]);
      } else if (cur().type === "[") {
        eat("[");
        const key = parseValue();
        eat("]");
        eat("=");
        if (typeof key !== "string" && typeof key !== "number") {
          throw new LuaParseError("Only string/int table keys are supported");
        }
        items.push([key, parseValue()]);
      } else {
        items.push([arrayIndex, parseValue()]);
        arrayIndex += 1;
      }

      if (cur().type === "," || cur().type === ";") eat();
    }
    eat("}");

    // A table whose keys are exactly 1..n is a Lua array, and becomes a JSON
    // array. Anything else — string keys, or gaps — stays an object.
    const keys = items.map(([key]) => key);
    if (keys.length > 0 && keys.every((key) => typeof key === "number")) {
      const numeric = keys as number[];
      const max = Math.max(...numeric);
      const dense = new Set(numeric).size === numeric.length && max === numeric.length;
      if (dense) {
        const out: LuaValue[] = Array.from({ length: max }, () => null);
        for (const [key, value] of items) out[(key as number) - 1] = value;
        return out;
      }
    }

    const out: Record<string, LuaValue> = {};
    for (const [key, value] of items) out[String(key)] = value;
    return out;
  };

  if (cur().type === "ident" && cur().value === "return") eat("ident");
  const value = parseValue();
  if (cur().type !== "eof") throw new LuaParseError(`Trailing tokens at ${cur().pos}`);
  return value;
}

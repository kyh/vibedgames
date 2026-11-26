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

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const IDENT_START = /[A-Za-z_]/u;
const IDENT_BODY = /[A-Za-z0-9_]/u;

const punctuationOf = (ch: string) => {
  switch (ch) {
    case "{":
    case "}":
    case "[":
    case "]":
    case "=":
    case ",":
    case ";": {
      return ch;
    }

    default: {
      return null;
    }
  }
};

const isSpace = (ch: string) => ch !== "" && /\s/u.test(ch);

const isDigit = (ch: string) => ch >= "0" && ch <= "9";

interface Cursor {
  readonly text: string;
  i: number;
}

const peek = (cur: Cursor, n = 0) => cur.text.charAt(cur.i + n);

const skipTrivia = (cur: Cursor) => {
  for (;;) {
    while (isSpace(peek(cur))) {
      cur.i += 1;
    }

    if (peek(cur) !== "-" || peek(cur, 1) !== "-") {
      return;
    }

    cur.i += 2;

    if (peek(cur) === "[" && peek(cur, 1) === "[") {
      cur.i += 2;
      const end = cur.text.indexOf("]]", cur.i);
      cur.i = end === -1 ? cur.text.length : end + 2;
    } else {
      while (peek(cur) !== "" && peek(cur) !== "\n") {
        cur.i += 1;
      }
    }
  }
};

const ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ['"', '"'],
  ["'", "'"],
  ["\\", "\\"],
]);

const readString = (cur: Cursor) => {
  const quote = peek(cur);
  cur.i += 1;
  const out: string[] = [];

  for (;;) {
    const c = peek(cur);

    if (c === "") {
      throw new LuaParseError("Unterminated string");
    }

    if (c === quote) {
      cur.i += 1;

      return out.join("");
    }

    if (c === "\\") {
      cur.i += 1;
      const esc = peek(cur);
      out.push(ESCAPES.get(esc) ?? `\\${esc}`);

      if (esc !== "") {
        cur.i += 1;
      }

      continue;
    }

    out.push(c);
    cur.i += 1;
  }
};

const readWhile = (cur: Cursor, from: number, accept: (ch: string) => boolean) => {
  let j = from;

  while (j < cur.text.length && accept(cur.text.charAt(j))) {
    j += 1;
  }

  const value = cur.text.slice(cur.i, j);
  cur.i = j;

  return value;
};

const tokenize = (text: string) => {
  const tokens: Token[] = [];
  const cur: Cursor = { i: 0, text };

  for (;;) {
    skipTrivia(cur);

    if (cur.i >= text.length) {
      tokens.push({ pos: cur.i, type: "eof", value: "" });

      return tokens;
    }

    const ch = peek(cur);
    const pos = cur.i;

    const punctuation = punctuationOf(ch);

    if (punctuation !== null) {
      tokens.push({ pos, type: punctuation, value: punctuation });
      cur.i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      tokens.push({ pos, type: "string", value: readString(cur) });
      continue;
    }

    if (isDigit(ch) || (ch === "-" && isDigit(peek(cur, 1)))) {
      const from = ch === "-" ? cur.i + 1 : cur.i;
      const value = readWhile(cur, from, (c) => isDigit(c) || c === ".");
      tokens.push({ pos, type: "number", value });
      continue;
    }

    if (IDENT_START.test(ch)) {
      const value = readWhile(cur, cur.i + 1, (c) => IDENT_BODY.test(c));
      tokens.push({ pos, type: "ident", value });
      continue;
    }

    throw new LuaParseError(`Unexpected character at ${pos}: '${ch}'`);
  }
};

type TableKey = { kind: "index"; index: number } | { kind: "name"; name: string };

const LEADING_NUMBER = /^-?\d+(?:\.\d*)?/u;

const numberTokenValue = (raw: string) => Number(LEADING_NUMBER.exec(raw)?.[0]);

/** Parse a Lua table literal (optionally `return`-prefixed) into JSON data. */
export const parseLua = (text: string) => {
  const tokens = tokenize(text);
  let k = 0;

  const EOF: Token = { pos: text.length, type: "eof", value: "" };
  const cur = () => tokens[k] ?? EOF;
  const peekToken = (n = 1) => tokens[Math.min(k + n, tokens.length - 1)] ?? EOF;

  const eat = (type?: TokenType) => {
    const token = cur();

    if (type !== undefined && token.type !== type) {
      throw new LuaParseError(`Expected ${type}, got ${token.type} at ${token.pos}`);
    }

    k += 1;

    return token;
  };

  const parseValue = () => {
    const token = cur();

    if (token.type === "{") {
      return parseTable();
    }

    if (token.type === "string") {
      eat("string");

      return token.value;
    }

    if (token.type === "number") {
      eat("number");

      return numberTokenValue(token.value);
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

  const parseTable = () => {
    eat("{");
    const items: [TableKey, LuaValue][] = [];
    let arrayIndex = 1;

    while (cur().type !== "}") {
      if (cur().type === "ident" && peekToken().type === "=") {
        const key = eat("ident").value;
        eat("=");
        items.push([{ kind: "name", name: key }, parseValue()]);
      } else if (cur().type === "[") {
        eat("[");
        const keyToken = cur();
        parseValue();
        eat("]");
        eat("=");

        if (keyToken.type === "string") {
          items.push([{ kind: "name", name: keyToken.value }, parseValue()]);
        } else if (keyToken.type === "number") {
          items.push([{ index: numberTokenValue(keyToken.value), kind: "index" }, parseValue()]);
        } else {
          throw new LuaParseError("Only string/int table keys are supported");
        }
      } else {
        items.push([{ index: arrayIndex, kind: "index" }, parseValue()]);
        arrayIndex += 1;
      }

      if (cur().type === "," || cur().type === ";") {
        eat();
      }
    }

    eat("}");

    const numeric: number[] = [];

    for (const [key] of items) {
      if (key.kind === "index") {
        numeric.push(key.index);
      }
    }

    if (items.length > 0 && numeric.length === items.length) {
      const max = Math.max(...numeric);
      const dense = new Set(numeric).size === numeric.length && max === numeric.length;

      if (dense) {
        const out: LuaValue[] = Array.from({ length: max }, () => null);

        for (const [key, value] of items) {
          if (key.kind === "index") {
            out[key.index - 1] = value;
          }
        }

        return out;
      }
    }

    const out: Record<string, LuaValue> = {};

    for (const [key, value] of items) {
      out[key.kind === "index" ? String(key.index) : key.name] = value;
    }

    return out;
  };

  if (cur().type === "ident" && cur().value === "return") {
    eat("ident");
  }

  const value = parseValue();

  if (cur().type !== "eof") {
    throw new LuaParseError(`Trailing tokens at ${cur().pos}`);
  }

  return value;
};

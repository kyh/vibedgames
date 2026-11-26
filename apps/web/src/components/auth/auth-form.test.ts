import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const source = readFileSync(path.join(import.meta.dirname, "auth-form.tsx"), "utf-8");

const formTags = [...source.matchAll(/<form\b[^>]*>/gu)].map((match) => ({
  line: source.slice(0, match.index).split("\n").length,
  tag: match[0],
}));

test("every auth form posts, so a submit before hydration keeps credentials out of the URL", () => {
  assert.equal(formTags.length, 3);

  for (const { line, tag } of formTags) {
    assert.match(tag, /\smethod="post"\s/u, `auth-form.tsx:${line} has no method="post"`);
  }
});

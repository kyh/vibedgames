import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const source = readFileSync(path.join(import.meta.dirname, "auth-form.tsx"), "utf-8");

const formTags = [...source.matchAll(/<form\b[^>]*>/gu)].map((match) => match[0]);

test("the one form tag posts, so no submit keeps credentials in the URL", () => {
  assert.equal(formTags.length, 1);
  assert.match(formTags[0] ?? "", /\smethod="post"\s/u);
});

test("every auth form is the wrapper that holds its fields until hydration", () => {
  assert.match(source, /<fieldset disabled=\{!hydrated\}/u);
  assert.equal([...source.matchAll(/<HydratedForm\b/gu)].length, 3);
});

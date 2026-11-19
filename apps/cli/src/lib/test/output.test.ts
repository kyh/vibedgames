import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { formatField, isJsonOutput, selectField, writeStructured } from "../output.js";

const RESULT = {
  downloaded_files: ["out/a.png", "out/b.png"],
  request_id: "req_123",
  result: {
    images: [
      { url: "https://cdn/a.png", width: 512 },
      { url: "https://cdn/b.png", width: 1024 },
    ],
    nsfw: [false, false],
    seed: 42,
  },
  status: "completed",
};

test("selectField walks dotted paths", () => {
  assert.equal(selectField(RESULT, "request_id"), "req_123");
  assert.equal(selectField(RESULT, "result.seed"), 42);
  assert.deepEqual(selectField(RESULT, "result.images"), RESULT.result.images);
});

test("selectField accepts both array spellings", () => {
  assert.equal(selectField(RESULT, "result.images[0].url"), "https://cdn/a.png");
  assert.equal(selectField(RESULT, "result.images.0.url"), "https://cdn/a.png");
  assert.equal(selectField(RESULT, "result.images[1].width"), 1024);
});

test("a negative index counts from the end", () => {
  assert.equal(selectField(RESULT, "result.images[-1].url"), "https://cdn/b.png");
  assert.equal(selectField(RESULT, "downloaded_files[-1]"), "out/b.png");
});

test("an unresolvable path is undefined rather than a throw", () => {
  assert.equal(selectField(RESULT, "nope"), undefined);
  assert.equal(selectField(RESULT, "result.images[9].url"), undefined);
  assert.equal(selectField(RESULT, "request_id.deeper"), undefined);
  assert.equal(selectField(RESULT, "result.images.notanindex"), undefined);
  assert.equal(selectField(null, "a.b"), undefined);
});

test("an empty path selects the whole value", () => {
  assert.equal(selectField(RESULT, ""), RESULT);
});

test("formatField prints scalars bare for shell capture", () => {
  assert.equal(formatField("https://cdn/a.png"), "https://cdn/a.png");
  assert.equal(formatField(42), "42");
  assert.equal(formatField(false), "false");
  assert.equal(formatField(null), "");
  assert.equal(formatField(), "");
});

test("formatField prints scalar arrays one per line so a shell can loop", () => {
  assert.equal(formatField(["a", "b"]), "a\nb");
  assert.equal(formatField([1, 2, 3]), "1\n2\n3");
  assert.equal(formatField([false, false]), "false\nfalse");
  assert.equal(formatField([]), "");
});

test("formatField falls back to JSON for structural values", () => {
  assert.equal(formatField({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(formatField([{ a: 1 }]), '[\n  {\n    "a": 1\n  }\n]');
});

const captureStdout = (body: () => void) => {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf-8") : chunk;

    return true;
  }) as typeof process.stdout.write;

  try {
    body();
  } finally {
    process.stdout.write = original;
  }

  return captured;
};

test("writeStructured returns false when neither flag is set", () => {
  const out = captureStdout(() => {
    assert.equal(writeStructured(RESULT, {}), false);
  });

  assert.equal(out, "");
});

test("--json prints the whole payload", () => {
  const out = captureStdout(() => {
    assert.equal(writeStructured({ a: 1 }, { json: true }), true);
  });

  assert.equal(out, '{\n  "a": 1\n}\n');
});

test("--field wins over --json, since it is the more specific request", () => {
  const out = captureStdout(() => {
    writeStructured(RESULT, { field: "request_id", json: true });
  });

  assert.equal(out, "req_123\n");
});

test("VG_JSON_OUTPUT=1 turns on JSON without the flag", () => {
  const previous = process.env.VG_JSON_OUTPUT;
  process.env.VG_JSON_OUTPUT = "1";

  try {
    assert.equal(isJsonOutput({}), true);
    const out = captureStdout(() => writeStructured({ a: 1 }, {}));
    assert.equal(out, '{\n  "a": 1\n}\n');
  } finally {
    if (previous === undefined) {
      delete process.env.VG_JSON_OUTPUT;
    } else {
      process.env.VG_JSON_OUTPUT = previous;
    }
  }
});

test("a field that does not resolve exits non-zero rather than printing nothing", () => {
  const output = new URL("../output.ts", import.meta.url).href;

  const script = `const { writeStructured } = await import(${JSON.stringify(output)});
writeStructured(${JSON.stringify(RESULT)}, { field: "typo" });`;

  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf-8" },
  );

  assert.equal(res.status, 1);
  assert.equal(res.stderr, "No such field: typo\n");
  assert.equal(res.stdout, "");
});

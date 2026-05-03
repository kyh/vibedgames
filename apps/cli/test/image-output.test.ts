import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import { resolveOutputTarget } from "../src/lib/image-output";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vg-image-output-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("missing output uses fallback directory", () => {
  const root = tempRoot();
  assert.deepEqual(resolveOutputTarget(undefined, root), { kind: "dir", dir: root });
});

test("existing directory stays directory mode", () => {
  const root = tempRoot();
  const dir = join(root, "out");
  mkdirSync(dir);
  assert.deepEqual(resolveOutputTarget(dir, root), { kind: "dir", dir });
});

test("trailing separator selects directory mode", () => {
  const root = tempRoot();
  const dir = join(root, "new-dir");
  assert.deepEqual(resolveOutputTarget(`${dir}/`, root), { kind: "dir", dir });
});

test("new extensionless output path is a file", () => {
  const root = tempRoot();
  const path = join(root, "result");
  assert.deepEqual(resolveOutputTarget(path, root), {
    kind: "file",
    path,
    dir: root,
  });
});

test("relative output path resolves as a file", () => {
  assert.deepEqual(resolveOutputTarget("result", "/tmp"), {
    kind: "file",
    path: resolve("result"),
    dir: process.cwd(),
  });
});

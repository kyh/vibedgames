import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { sourceArchive } from "./source-archive";

const bytes = (text: string) => new TextEncoder().encode(text);

// Extracted by the system tar, as `vg fork`'s tar would: the archive must be
// one a real reader accepts, not one only this module can read back.
const extract = (archive: Uint8Array): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "vg-source-"));
  writeFileSync(path.join(dir, "source.tgz"), archive);
  execFileSync("tar", ["-xzf", "source.tgz"], { cwd: dir });
  return dir;
};

describe("sourceArchive", () => {
  test("extracts to the same files at the same paths", async () => {
    const long = `${"assets/".repeat(15)}sprite-sheet.png`;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    const archive = await sourceArchive([
      { bytes: bytes("<p>hi</p>"), path: "index.html" },
      { bytes: bytes(""), path: "empty.txt" },
      { bytes: png, path: long },
      { bytes: bytes("x".repeat(1000)), path: "js/main.js" },
    ]);
    const dir = extract(archive);
    try {
      assert.equal(readFileSync(path.join(dir, "index.html"), "utf-8"), "<p>hi</p>");
      assert.equal(readFileSync(path.join(dir, "empty.txt"), "utf-8"), "");
      assert.deepEqual([...readFileSync(path.join(dir, long))], [...png]);
      assert.equal(readFileSync(path.join(dir, "js/main.js"), "utf-8"), "x".repeat(1000));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("refuses a path no ustar header can hold", async () => {
    await assert.rejects(sourceArchive([{ bytes: bytes("x"), path: "a".repeat(120) }]), {
      code: "BAD_REQUEST",
    });
  });
});

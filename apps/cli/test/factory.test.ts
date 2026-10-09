import assert from "node:assert/strict";
import { test } from "node:test";

import { factoryPackageFor } from "../src/commands/factory.js";

test("factoryPackageFor names the platform package, splitting Linux by C library", () => {
  const glibc = { header: { glibcVersionRuntime: "2.39" } };
  const musl = { header: { osName: "Linux" } };
  assert.equal(factoryPackageFor("darwin", "arm64", null), "@vibedgames/factory-darwin-arm64");
  assert.equal(factoryPackageFor("win32", "x64", null), "@vibedgames/factory-win32-x64");
  assert.equal(factoryPackageFor("linux", "x64", glibc), "@vibedgames/factory-linux-x64");
  assert.equal(factoryPackageFor("linux", "arm64", musl), "@vibedgames/factory-linux-arm64-musl");
});

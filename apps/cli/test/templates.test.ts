import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { copyTemplate, SLUG_TOKEN, TEMPLATES_DIR } from "../src/lib/templates.js";
import { isJsonObject, isJsonString } from "../src/lib/types.js";
import { makeCleanups, makeTmpDir } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

const ENGINES = ["phaser", "threejs", "react-r3f", "none"];

/** Every file under `dir`, relative to it. */
const listFiles = (dir: string, relative = ""): string[] =>
  readdirSync(path.join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? listFiles(dir, child) : [child];
  });

test("every engine preset has a bundled template", () => {
  assert.deepEqual(readdirSync(TEMPLATES_DIR).toSorted(), ENGINES.toSorted());
});

for (const engine of ENGINES) {
  test(`copyTemplate(${engine}) scaffolds a deployable Vite project`, () => {
    const target = makeTmpDir(cleanups, `vg-new-${engine}-`);
    assert.deepEqual(copyTemplate(engine, target, "neon-slasher", false), []);
    const files = listFiles(target);

    // npm drops `.gitignore` from published packages; the stand-in becomes it.
    assert.ok(files.includes(".gitignore"));
    assert.ok(!files.includes("_gitignore"));
    for (const file of files) {
      assert.ok(
        !readFileSync(path.join(target, file), "utf-8").includes(SLUG_TOKEN),
        `${file} still carries ${SLUG_TOKEN}`,
      );
    }

    const pkg: unknown = JSON.parse(readFileSync(path.join(target, "package.json"), "utf-8"));
    assert.ok(isJsonObject(pkg));
    assert.equal(pkg.name, "neon-slasher");
    assert.ok(isJsonObject(pkg.scripts));
    for (const script of ["build", "dev", "typecheck"]) {
      assert.ok(isJsonString(pkg.scripts[script]), `missing the ${script} script`);
    }
    // Relative asset URLs, so the build works under {slug}.vibedgames.com.
    assert.match(readFileSync(path.join(target, "vite.config.ts"), "utf-8"), /base: "\.\/"/u);
    assert.match(readFileSync(path.join(target, "index.html"), "utf-8"), /<title>neon-slasher</u);
  });
}

test("copyTemplate keeps existing files unless forced", () => {
  const target = makeTmpDir(cleanups, "vg-new-keep-");
  writeFileSync(path.join(target, "index.html"), "mine");

  assert.deepEqual(copyTemplate("none", target, "kept", false), ["index.html"]);
  assert.equal(readFileSync(path.join(target, "index.html"), "utf-8"), "mine");
  assert.ok(existsSync(path.join(target, "src", "main.ts")));

  assert.deepEqual(copyTemplate("none", target, "kept", true), []);
  assert.match(readFileSync(path.join(target, "index.html"), "utf-8"), /<title>kept</u);
});

test("copyTemplate skips install and build output left in a template", () => {
  const templates = makeTmpDir(cleanups, "vg-templates-");
  for (const file of [
    "demo/node_modules/dep/index.js",
    "demo/dist/index.html",
    "demo/src/main.ts",
  ]) {
    const full = path.join(templates, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "export {};\n");
  }
  const target = makeTmpDir(cleanups, "vg-new-skip-");
  copyTemplate("demo", target, "x", false, templates);
  assert.deepEqual(listFiles(target), [path.join("src", "main.ts")]);
});

test("copyTemplate names an unknown template", () => {
  const target = makeTmpDir(cleanups, "vg-new-missing-");
  assert.throws(
    () => copyTemplate("unreal", target, "x", false),
    /No bundled template named "unreal"/u,
  );
});

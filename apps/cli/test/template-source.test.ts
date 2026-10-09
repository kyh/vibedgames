import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { create as tarCreate } from "tar";

import {
  fetchTemplate,
  parseTemplateSpec,
  templateTarballUrl,
} from "../src/lib/template-source.js";
import { makeCleanups, makeTmpDir } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

test("parseTemplateSpec reads every GitHub spelling of a repo, path and ref", () => {
  const cases: [string, ReturnType<typeof parseTemplateSpec>][] = [
    ["owner/repo", { owner: "owner", ref: "HEAD", repo: "repo", subdir: "" }],
    ["owner/repo#v2", { owner: "owner", ref: "v2", repo: "repo", subdir: "" }],
    [
      "owner/repo/templates/game#feat/x",
      { owner: "owner", ref: "feat/x", repo: "repo", subdir: "templates/game" },
    ],
    ["github:owner/repo", { owner: "owner", ref: "HEAD", repo: "repo", subdir: "" }],
    [
      "https://github.com/owner/repo.git",
      { owner: "owner", ref: "HEAD", repo: "repo", subdir: "" },
    ],
    [
      "git@github.com:owner/repo.git#main",
      { owner: "owner", ref: "main", repo: "repo", subdir: "" },
    ],
    ["owner/repo/", { owner: "owner", ref: "HEAD", repo: "repo", subdir: "" }],
  ];
  for (const [spec, expected] of cases) {
    assert.deepEqual(parseTemplateSpec(spec), expected, spec);
  }
});

test("parseTemplateSpec refuses other hosts and malformed specs, naming the accepted forms", () => {
  for (const spec of ["gitlab:owner/repo", "https://gitlab.com/owner/repo"]) {
    assert.throws(() => parseTemplateSpec(spec), /Only GitHub templates/u, spec);
  }
  for (const spec of ["owner", "owner/repo#", "owner/repo/../x", "-owner/repo", "owner/re po"]) {
    assert.throws(() => parseTemplateSpec(spec), /owner\/repo, owner\/repo\/sub\/dir/u, spec);
  }
});

test("templateTarballUrl asks codeload for the ref, keeping a branch's slashes", () => {
  assert.equal(
    templateTarballUrl(parseTemplateSpec("owner/repo#feat/x+y")),
    "https://codeload.github.com/owner/repo/tar.gz/feat/x%2By",
  );
  assert.equal(
    templateTarballUrl(parseTemplateSpec("owner/repo")),
    "https://codeload.github.com/owner/repo/tar.gz/HEAD",
  );
});

/** A tarball shaped like GitHub's: the tree under one `repo-HEAD/` directory. */
const githubTarball = async (files: Record<string, string>): Promise<Buffer> => {
  const work = makeTmpDir(cleanups, "vg-template-src-");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(work, "repo-HEAD", file)), { recursive: true });
    writeFileSync(path.join(work, "repo-HEAD", file), content);
  }
  const tarball = path.join(work, "repo.tgz");
  await tarCreate({ cwd: work, file: tarball, gzip: true, portable: true }, ["repo-HEAD"]);
  return readFileSync(tarball);
};

const serving =
  (body: Buffer, requested: string[] = []): typeof fetch =>
  (input) => {
    requested.push(String(input));
    return Promise.resolve(new Response(body));
  };

const listFiles = (dir: string, relative = ""): string[] =>
  readdirSync(path.join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? listFiles(dir, child) : [child];
  });

const TEMPLATE_FILES = {
  "README.md": "# repo\n",
  "package.json": "{}\n",
  "templates/game/index.html": "<canvas></canvas>\n",
  "templates/game/src/main.ts": "export {};\n",
};

test("fetchTemplate unpacks the repo's tree without GitHub's wrapper directory", async () => {
  const target = makeTmpDir(cleanups, "vg-template-");
  const requested: string[] = [];
  await fetchTemplate(
    parseTemplateSpec("owner/repo"),
    target,
    false,
    serving(await githubTarball(TEMPLATE_FILES), requested),
  );
  assert.deepEqual(listFiles(target).toSorted(), Object.keys(TEMPLATE_FILES).toSorted());
  assert.deepEqual(requested, ["https://codeload.github.com/owner/repo/tar.gz/HEAD"]);
});

test("fetchTemplate scaffolds from a directory inside the repo", async () => {
  const target = makeTmpDir(cleanups, "vg-template-");
  await fetchTemplate(
    parseTemplateSpec("owner/repo/templates/game"),
    target,
    false,
    serving(await githubTarball(TEMPLATE_FILES)),
  );
  assert.deepEqual(listFiles(target).toSorted(), ["index.html", path.join("src", "main.ts")]);
});

test("fetchTemplate says which directory a repo lacks", async () => {
  const target = makeTmpDir(cleanups, "vg-template-");
  await assert.rejects(
    fetchTemplate(
      parseTemplateSpec("owner/repo/templates/nope"),
      target,
      false,
      serving(await githubTarball(TEMPLATE_FILES)),
    ),
    /owner\/repo has no directory templates\/nope at HEAD/u,
  );
});

test("fetchTemplate names a repo or ref GitHub doesn't have", async () => {
  const target = makeTmpDir(cleanups, "vg-template-");
  await assert.rejects(
    fetchTemplate(parseTemplateSpec("owner/repo#nope"), target, false, () =>
      Promise.resolve(new Response("404: Not Found", { status: 404 })),
    ),
    /GitHub has no owner\/repo at nope/u,
  );
});

test("fetchTemplate refuses a non-empty target unless forced, then overwrites", async () => {
  const target = makeTmpDir(cleanups, "vg-template-");
  writeFileSync(path.join(target, "README.md"), "mine\n");
  const tarball = await githubTarball(TEMPLATE_FILES);
  await assert.rejects(
    fetchTemplate(parseTemplateSpec("owner/repo"), target, false, serving(tarball)),
    /is not empty\. Pass --force/u,
  );
  await fetchTemplate(parseTemplateSpec("owner/repo"), target, true, serving(tarball));
  assert.equal(readFileSync(path.join(target, "README.md"), "utf-8"), "# repo\n");
});

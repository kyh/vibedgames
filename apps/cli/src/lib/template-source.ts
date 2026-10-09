import { once } from "node:events";
import { readdirSync } from "node:fs";

import { extract as tarExtract } from "tar";

/**
 * `vg new --template`: scaffold from a third-party template on GitHub.
 *
 * The spec is degit's, for GitHub: `owner/repo`, then an optional path inside
 * it (`owner/repo/sub/dir`) and an optional `#ref` (branch, tag or commit).
 * `github:owner/repo`, `https://github.com/owner/repo(.git)` and
 * `git@github.com:owner/repo(.git)` name the same repo. The files arrive as
 * GitHub's tarball of the ref, unpacked straight into the target, so neither
 * git nor a local cache is involved.
 */

export interface TemplateSpec {
  owner: string;
  repo: string;
  /** Directory inside the repo to scaffold from; empty for its root. */
  subdir: string;
  /** Branch, tag or commit. `HEAD` is the default branch. */
  ref: string;
}

const REPO_PREFIXES = ["github:", "https://github.com/", "http://github.com/", "git@github.com:"];
const OTHER_HOSTS =
  /^(?:gitlab|bitbucket|sourcehut|codeberg):|^(?:https?:\/\/|git@)(?!github\.com[/:])/u;
const OWNER = /^[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?$/u;
const NAME = /^[\w.-]+$/u;

const SPEC_FORMS = "owner/repo, owner/repo/sub/dir or owner/repo#ref";

/** Parse a template spec, or throw an error that names the accepted forms. */
export const parseTemplateSpec = (spec: string): TemplateSpec => {
  const trimmed = spec.trim();
  const hashAt = trimmed.indexOf("#");
  const location = hashAt === -1 ? trimmed : trimmed.slice(0, hashAt);
  const ref = hashAt === -1 ? "HEAD" : trimmed.slice(hashAt + 1);
  if (OTHER_HOSTS.test(location)) {
    throw new Error(`Only GitHub templates are supported: ${SPEC_FORMS}.`);
  }
  const prefix = REPO_PREFIXES.find((candidate) => location.startsWith(candidate)) ?? "";
  const [owner = "", repoSegment = "", ...subdir] = location
    .slice(prefix.length)
    .replace(/\/+$/u, "")
    .split("/");
  const repo = repoSegment.replace(/\.git$/u, "");
  if (
    !OWNER.test(owner) ||
    !NAME.test(repo) ||
    subdir.some((part) => !NAME.test(part) || part === "." || part === "..") ||
    !ref ||
    /\s/u.test(ref)
  ) {
    throw new Error(`"${spec}" is not a GitHub template spec. Use ${SPEC_FORMS}.`);
  }
  return { owner, ref, repo, subdir: subdir.join("/") };
};

/** GitHub's tarball of the ref, which wraps the tree in one `<repo>-<ref>/` directory. */
export const templateTarballUrl = ({ owner, repo, ref }: TemplateSpec): string =>
  `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Unpack the template into `target`. A non-empty `target` is refused unless
 * `force`, which overwrites whatever the template also carries.
 */
export const fetchTemplate = async (
  template: TemplateSpec,
  target: string,
  force: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> => {
  if (!force && readdirSync(target).length > 0) {
    throw new Error(`${target} is not empty. Pass --force to scaffold into it anyway.`);
  }
  const url = templateTarballUrl(template);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (res.status === 404) {
    throw new Error(
      `GitHub has no ${template.owner}/${template.repo} at ${template.ref} (or the repo is private).`,
    );
  }
  if (!res.ok) {
    throw new Error(`Couldn't download ${url}: HTTP ${res.status}.`);
  }
  const tarball = Buffer.from(await res.arrayBuffer());
  const prefix = template.subdir ? template.subdir.split("/") : [];
  let unpacked = 0;
  const unpack = tarExtract({
    cwd: target,
    filter: (entryPath) => {
      // `entryPath` still has the wrapper directory `strip` removes.
      const parts = entryPath.split("/").slice(1);
      const inside =
        parts.length > prefix.length && prefix.every((part, index) => parts[index] === part);
      if (inside) {
        unpacked += 1;
      }
      return inside;
    },
    strip: 1 + prefix.length,
  });
  // Listened for before the write: with nothing to unpack, it closes inside `end`.
  const closed = once(unpack, "close");
  unpack.end(tarball);
  await closed;
  if (unpacked === 0) {
    throw new Error(
      template.subdir
        ? `${template.owner}/${template.repo} has no directory ${template.subdir} at ${template.ref}.`
        : `${template.owner}/${template.repo} at ${template.ref} has no files.`,
    );
  }
};

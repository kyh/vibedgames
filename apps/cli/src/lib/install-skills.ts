import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import consola from "consola";
import { extract } from "tar-stream";

const REPO = "kyh/vibedgames";
const BRANCH = "main";
const PREFIX = `vibedgames-${BRANCH}/plugins/`;

const isInside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
};

const extractToTarget = (targetDir: string) => {
  const targetResolved = resolve(targetDir);
  const installed = new Set<string>();
  const wiped = new Set<string>();
  const extractor = extract();

  extractor.on("entry", (header, stream, next) => {
    const skip = () => {
      stream.on("end", next);
      stream.resume();
    };

    if (!header.name.startsWith(PREFIX)) return skip();
    const parts = header.name.slice(PREFIX.length).split("/").filter(Boolean);
    const [, skillsSegment, skill, ...rest] = parts;
    if (skillsSegment !== "skills" || !skill) return skip();

    const outPath = resolve(targetResolved, skill, ...rest);
    if (!isInside(targetResolved, outPath)) {
      next(new Error(`Refusing to extract outside target dir: ${header.name}`));
      return;
    }

    if (!wiped.has(skill)) {
      rmSync(resolve(targetResolved, skill), { recursive: true, force: true });
      wiped.add(skill);
    }
    installed.add(skill);

    if (header.type === "directory") {
      mkdirSync(outPath, { recursive: true });
      return skip();
    }

    if (header.type === "file") {
      mkdirSync(dirname(outPath), { recursive: true });
      pipeline(stream, createWriteStream(outPath)).then(() => next(), next);
      return;
    }

    return skip();
  });

  return { extractor, installed };
};

export const installSkills = async (projectDir: string, force: boolean) => {
  const targetDir = resolve(projectDir, ".claude", "skills");
  const tarballUrl = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`;

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !force) {
    const proceed = await consola.prompt(
      `${targetDir} already has content. Overwrite existing skills?`,
      { type: "confirm", initial: false },
    );
    if (!proceed) {
      consola.info("Aborted.");
      return;
    }
  }

  consola.start("Fetching skills from vibedgames...");

  const res = await fetch(tarballUrl);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download tarball: ${res.status}`);
  }

  mkdirSync(targetDir, { recursive: true });

  const { extractor, installed } = extractToTarget(targetDir);
  await pipeline(Readable.fromWeb(res.body), createGunzip(), extractor);

  const skills = [...installed];
  consola.success(`Installed ${skills.length} skills to ${targetDir}`);
  consola.log(`  ${skills.join(", ")}`);
};

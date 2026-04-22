import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import consola from "consola";
import { extract } from "tar-stream";

const REPO = "kyh/vibedgames";
const BRANCH = "main";

const extractFiltered = (tmpDir: string, prefix: string) => {
  const extractor = extract();

  extractor.on("entry", (header, stream, next) => {
    if (!header.name.startsWith(prefix)) {
      stream.on("end", next);
      stream.resume();
      return;
    }

    const relPath = header.name.slice(prefix.length);
    if (!relPath) {
      stream.on("end", next);
      stream.resume();
      return;
    }

    const outPath = join(tmpDir, relPath);

    if (header.type === "directory") {
      mkdirSync(outPath, { recursive: true });
      stream.on("end", next);
      stream.resume();
      return;
    }

    if (header.type === "file") {
      mkdirSync(dirname(outPath), { recursive: true });
      stream.pipe(createWriteStream(outPath)).on("finish", next);
      return;
    }

    stream.on("end", next);
    stream.resume();
  });

  return extractor;
};

export const installSkills = async (projectDir: string, force: boolean) => {
  const targetDir = join(projectDir, ".claude", "skills");
  const tarballUrl = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`;
  const tmpDir = join(projectDir, ".vg-skills-tmp");

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

  try {
    mkdirSync(tmpDir, { recursive: true });

    const res = await fetch(tarballUrl);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download tarball: ${res.status}`);
    }

    const prefix = `vibedgames-${BRANCH}/plugins/`;
    await pipeline(
      Readable.fromWeb(res.body),
      createGunzip(),
      extractFiltered(tmpDir, prefix),
    );

    mkdirSync(targetDir, { recursive: true });

    const installed: string[] = [];

    for (const plugin of readdirSync(tmpDir)) {
      const skillsDir = join(tmpDir, plugin, "skills");
      if (!existsSync(skillsDir)) continue;

      for (const skill of readdirSync(skillsDir)) {
        const dest = join(targetDir, skill);
        if (existsSync(dest)) rmSync(dest, { recursive: true });
        cpSync(join(skillsDir, skill), dest, { recursive: true });
        installed.push(skill);
      }
    }

    consola.success(`Installed ${installed.length} skills to ${targetDir}`);
    consola.log(`  ${installed.join(", ")}`);
  } catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  }
};

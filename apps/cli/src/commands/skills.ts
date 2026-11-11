import { defineCommand } from "citty";
import { consola } from "consola";

import { getBaseUrl } from "../lib/config.js";
import { isJsonOutput, outputArgs, writeStructured } from "../lib/output.js";
import { assertKnownFlags } from "../lib/strict-args.js";
import { isJsonObject, isJsonString } from "../lib/types.js";
import type { JsonValue } from "../lib/types.js";

/**
 * The bundled game-studio skills, read from the platform's
 * `/.well-known/agent-skills` discovery index: the same bundle the `skills`
 * MCP tool and its `skill://` resources serve. No login needed. `vg init`
 * installs them into a project; this reads one without installing anything.
 */

const skillsArgs = {
  name: {
    description: "A skill's name; omit to list every skill and what it is for.",
    required: false,
    type: "positional",
  },
  ...outputArgs,
} as const;

const discoveryUrl = (path: string) => new URL(`/.well-known/agent-skills/${path}`, getBaseUrl());

const fetchOrExit = async (url: URL, doing: string): Promise<Response> => {
  try {
    return await fetch(url);
  } catch (error) {
    consola.error(`${doing}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};

// Inferred, not a named interface, so the rows fit writeStructured's JSON payload.
const summaries = (index: JsonValue) => {
  const skills = isJsonObject(index) ? index.skills : undefined;
  if (!Array.isArray(skills)) {
    return [];
  }
  return skills.flatMap((entry) => {
    if (!isJsonObject(entry) || !isJsonString(entry.name) || !isJsonString(entry.description)) {
      return [];
    }
    return [{ description: entry.description, name: entry.name }];
  });
};

const listSkills = async () => {
  const res = await fetchOrExit(discoveryUrl("index.json"), "Could not list the skills");
  if (!res.ok) {
    consola.error(`Could not list the skills: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const index: JsonValue = JSON.parse(await res.text());
  return summaries(index);
};

export const skillsCommand = defineCommand({
  args: skillsArgs,
  meta: {
    description:
      "The game-studio skills: list them, or print one's SKILL.md (how to build, art-direct, add multiplayer to, balance and ship a browser game).",
    name: "skills",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, skillsArgs);

    if (!args.name) {
      const skills = await listSkills();
      if (writeStructured({ skills }, args)) {
        return;
      }
      for (const skill of skills) {
        consola.log(`${skill.name}  ${skill.description}`);
      }
      return;
    }

    const name = args.name.trim();
    const res = await fetchOrExit(
      discoveryUrl(`${encodeURIComponent(name)}/SKILL.md`),
      `Could not fetch ${name}`,
    );
    if (res.status === 404) {
      consola.error(`No skill "${name}". Run \`vg skills\` to list them.`);
      process.exit(1);
    }
    if (!res.ok) {
      consola.error(`Could not fetch ${name}: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const content = await res.text();
    if (isJsonOutput(args) || args.field) {
      const listed = await listSkills();
      const summary = listed.find((skill) => skill.name === name);
      writeStructured({ content, description: summary?.description ?? "", name }, args);
      return;
    }
    process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
  },
});

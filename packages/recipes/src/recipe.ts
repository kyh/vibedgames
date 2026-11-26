import { mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { RecipeName } from "@repo/contract/asset/recipe-schema";
import { z } from "zod";

import type { ExecOptions, exec } from "./exec";
import type { Tools } from "./tools";

/** A recipe's file inputs as local paths, keyed by input field. */
export type RecipeFiles = Record<string, string | string[] | Record<string, string> | undefined>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface RecipeOutput {
  name: string;
  path: string;
  contentType: string;
  bytes: number;
}

export interface RecipeOutcome {
  result: JsonValue;
  outputs: RecipeOutput[];
}

export interface RecipeContext<P> {
  name: RecipeName;
  params: P;
  files: RecipeFiles;
  /** A scratch folder the recipe owns. */
  work: string;
  /** Where the recipe writes the files it returns. */
  out: string;
  tools: Tools;
  signal?: AbortSignal;
  run: (program: string, args: readonly string[], options?: ExecOptions) => ReturnType<typeof exec>;
}

/** A recipe refusing its input, with a message the caller can act on. */
export class RecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeError";
  }
}

const TYPES = {
  ".cube": "text/plain",
  ".glb": "model/gltf-binary",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".ts": "text/plain",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webp": "image/webp",
} as const satisfies Record<string, string>;

const TYPE_BY_EXT: ReadonlyMap<string, string> = new Map(Object.entries(TYPES));

export const contentTypeOf = (file: string) => {
  const ext = path.extname(file).toLowerCase();

  return TYPE_BY_EXT.get(ext) ?? "application/octet-stream";
};

const walkFiles = (dir: string, visit: (rel: string, full: string) => void) => {
  const walk = (sub: string) => {
    for (const entry of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isFile()) {
        visit(rel, path.join(dir, rel));
      }
    }
  };

  walk("");
};

const stampOf = (full: string) => {
  const info = statSync(full);

  return `${info.size}:${info.mtimeMs}`;
};

/** Every file under `dir`, by its path relative to it, with its size and modification time. */
export const snapshotFiles = (dir: string) => {
  const seen = new Map<string, string>();
  walkFiles(dir, (rel, full) => {
    seen.set(rel, stampOf(full));
  });

  return seen;
};

/** Lists every file under `dir` that is new or changed since `before`, named by its path relative to it. */
export const collectOutputs = (dir: string, before = new Map<string, string>()) => {
  const outputs: RecipeOutput[] = [];

  walkFiles(dir, (rel, full) => {
    if (before.get(rel) === stampOf(full)) {
      return;
    }

    outputs.push({
      bytes: statSync(full).size,
      contentType: contentTypeOf(full),
      name: rel,
      path: full,
    });
  });

  return outputs.toSorted((a, b) => a.name.localeCompare(b.name));
};

export const need = (tool: string | undefined, name: string) => {
  if (tool === undefined || tool === "") {
    throw new RecipeError(`${name} is not installed here.`);
  }

  return tool;
};

const filePath = z.string().min(1);
const fileList = z.array(filePath);
const fileMap = z.record(z.string(), filePath);

export const maybe = (files: RecipeFiles, key: string) => filePath.safeParse(files[key]).data;

export const one = (files: RecipeFiles, key: string) => {
  const value = maybe(files, key);

  if (value === undefined) {
    throw new RecipeError(`${key}: no file given.`);
  }

  return value;
};

export const many = (files: RecipeFiles, key: string) => {
  const value = fileList.safeParse(files[key]).data;

  if (value === undefined) {
    throw new RecipeError(`${key}: no files given.`);
  }

  return value;
};

export const named = (files: RecipeFiles, key: string) => fileMap.safeParse(files[key]).data ?? {};

export const ensureDir = (dir: string) => {
  mkdirSync(dir, { recursive: true });

  return dir;
};

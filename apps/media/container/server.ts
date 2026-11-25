import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { isRecipeName, MAX_RECIPE_INPUT_BYTES } from "@repo/contract/asset/recipe-schema";
import { RecipeError, runRecipe } from "@repo/recipes";
import type { JsonValue, RecipeFiles } from "@repo/recipes";
import { z } from "zod";

const ROOT = process.env.RECIPE_ROOT ?? "/work";
const INPUTS = path.join(ROOT, "in");
const OUTPUTS = path.join(ROOT, "out");
const PORT = Number(process.env.PORT ?? 8080);
const SAFE = /^(?!\.{1,2}(?:\/|$))[\w.-]+(?:\/(?!\.{1,2}(?:\/|$))[\w.-]+)*$/u;

const runBody = z.object({
  files: z.record(
    z.string(),
    z.union([z.string(), z.array(z.string()), z.record(z.string(), z.string())]),
  ),
  params: z.record(z.string(), z.json()),
  recipe: z.string(),
});

let busy = false;

type Reply = Readonly<Record<string, JsonValue>>;

const send = (res: ServerResponse, status: number, body: Reply) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readJson = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
};

const safePath = (dir: string, name: string) => {
  if (!SAFE.test(name)) {
    throw new RecipeError(`${name} is not a plain relative file name.`);
  }

  return path.join(dir, name);
};

const localFiles = (files: z.infer<typeof runBody>["files"]) => {
  const local: RecipeFiles = {};

  for (const [key, value] of Object.entries(files)) {
    if (Array.isArray(value)) {
      local[key] = value.map((name) => safePath(INPUTS, name));
    } else if (z.string().safeParse(value).success) {
      local[key] = safePath(INPUTS, String(value));
    } else {
      local[key] = Object.fromEntries(
        Object.entries(value).map(([rel, name]) => [rel, safePath(INPUTS, name)]),
      );
    }
  }

  return local;
};

const putInput = async (req: IncomingMessage, res: ServerResponse, name: string) => {
  const target = safePath(INPUTS, name);
  mkdirSync(path.dirname(target), { recursive: true });
  let size = 0;

  req.on("data", (chunk: Buffer) => {
    size += chunk.length;

    if (size > MAX_RECIPE_INPUT_BYTES) {
      req.destroy(new RecipeError(`${name} is over ${MAX_RECIPE_INPUT_BYTES} bytes.`));
    }
  });

  await pipeline(req, createWriteStream(target));
  send(res, 200, { bytes: size, name });
};

const run = async (req: IncomingMessage, res: ServerResponse) => {
  if (busy) {
    send(res, 409, { error: "A job is already running in this container." });

    return;
  }

  busy = true;

  try {
    const body = runBody.parse(await readJson(req));

    if (!isRecipeName(body.recipe)) {
      throw new RecipeError(`${body.recipe} is not a recipe.`);
    }

    rmSync(OUTPUTS, { force: true, recursive: true });
    const started = performance.now();

    const outcome = await runRecipe(body.recipe, {
      files: localFiles(body.files),
      out: OUTPUTS,
      params: body.params,
    });

    send(res, 200, {
      outputs: outcome.outputs.map(({ bytes, contentType, name }) => ({
        bytes,
        contentType,
        name,
      })),
      result: outcome.result,
      seconds: (performance.now() - started) / 1000,
    });
  } catch (error) {
    send(res, error instanceof RecipeError ? 422 : 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    busy = false;
  }
};

const getOutput = (res: ServerResponse, name: string) => {
  const file = safePath(OUTPUTS, name);
  const { size } = statSync(file);
  res.writeHead(200, {
    "content-length": String(size),
    "content-type": "application/octet-stream",
  });
  createReadStream(file).pipe(res);
};

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://container");
  const name = decodeURIComponent(url.pathname.replace(/^\/(?:in|out)\//u, ""));

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true });
  } else if (req.method === "PUT" && url.pathname.startsWith("/in/")) {
    await putInput(req, res, name);
  } else if (req.method === "POST" && url.pathname === "/run") {
    await run(req, res);
  } else if (req.method === "GET" && url.pathname.startsWith("/out/")) {
    getOutput(res, name);
  } else {
    send(res, 404, { error: "not found" });
  }
};

mkdirSync(INPUTS, { recursive: true });

createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    if (!res.headersSent) {
      send(res, error instanceof RecipeError ? 400 : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}).listen(PORT);

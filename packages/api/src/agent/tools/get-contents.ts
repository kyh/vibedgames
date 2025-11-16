import type { ModelMessage } from "ai";
import { streamObject } from "ai";
import z from "zod";

import { getModelOptions } from "../gateway";

export type File = z.infer<typeof fileSchema>;

const fileSchema = z.object({
  path: z
    .string()
    .describe(
      "Path to the file within the active workspace (relative to the project root, e.g., 'src/main.js', 'package.json', 'components/Button.tsx')",
    ),
  content: z
    .string()
    .describe(
      "The content of the file as a utf8 string (complete file contents that will replace any existing file at this path)",
    ),
});

type Params = {
  messages: ModelMessage[];
  modelId: string;
  paths: string[];
};

type FileContentChunk = {
  files: z.infer<typeof fileSchema>[];
  paths: string[];
  written: string[];
};

export async function* getContents(
  params: Params,
): AsyncGenerator<FileContentChunk> {
  const generated: z.infer<typeof fileSchema>[] = [];
  const deferred = new Deferred<void>();
  const result = streamObject({
    ...getModelOptions(params.modelId, { reasoningEffort: "minimal" }),
    maxOutputTokens: 64000,
    system:
      "You are a file content generator. You must generate files based on the conversation history and the provided paths. NEVER generate lock files (pnpm-lock.yaml, package-lock.json, yarn.lock) - these are automatically created by package managers.",
    messages: [
      ...params.messages,
      {
        role: "user",
        content: `Generate the content of the following files according to the conversation: ${params.paths.map(
          (path) => `\n - ${path}`,
        )}`,
      },
    ],
    schema: z.object({ files: z.array(fileSchema) }),
    onError: (error) => {
      deferred.reject(error);
      console.error("Error communicating with AI");
      console.error(JSON.stringify(error, null, 2));
    },
  });

  for await (const items of result.partialObjectStream) {
    if (!Array.isArray(items?.files)) {
      continue;
    }

    const written = generated.map((file) => file.path);
    const paths = written.concat(
      items.files
        .slice(generated.length, items.files.length - 1)
        .flatMap((f) => (f?.path ? [f.path] : [])),
    );

    const files = items.files
      .slice(generated.length, items.files.length - 2)
      .map((file) => fileSchema.parse(file));

    if (files.length > 0) {
      yield { files, paths, written };
      generated.push(...files);
    } else {
      yield { files: [], written, paths };
    }
  }

  const raceResult = await Promise.race([result.object, deferred.promise]);
  if (!raceResult) {
    throw new Error(
      "Unexpected Error: Deferred was resolved before the result",
    );
  }

  const written = generated.map((file) => file.path);
  const files = raceResult.files.slice(generated.length);
  const paths = written.concat(files.map((file) => file.path));
  if (files.length > 0) {
    yield { files, written, paths };
    generated.push(...files);
  }
}

class Deferred<T> {
  private resolveFn: (value: T | PromiseLike<T>) => void = () => {};
  private rejectFn: (reason?: any) => void = () => {};
  private _promise: Promise<T>;

  constructor() {
    this._promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  get promise() {
    return this._promise;
  }

  resolve(value: T | PromiseLike<T>): void {
    this.resolveFn(value);
  }

  reject(reason?: any): void {
    this.rejectFn(reason);
  }
}

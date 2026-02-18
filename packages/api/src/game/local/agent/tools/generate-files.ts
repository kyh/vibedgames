import type { UIMessage, UIMessageStreamWriter } from "ai";
import { Sandbox } from "@vercel/sandbox";
import { tool } from "ai";
import z from "zod/v3";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import type { File } from "@repo/api/game/local/agent/tools/generate-files/get-contents";
import type { Db } from "@repo/db/drizzle-client";
import { getContents } from "@repo/api/game/local/agent/tools/generate-files/get-contents";
import { getWriteFiles } from "@repo/api/game/local/agent/tools/generate-files/get-write-files";
import { getRichError } from "@repo/api/game/local/agent/tools/get-rich-error";

const description = `Use this tool to generate and upload code files into the Vercel Sandbox environment. It leverages an LLM to create file contents based on the current conversation context and user intent, then writes them directly into the sandbox file system and persists them to the database.

The generated files should be considered correct on first iteration and suitable for immediate use in the sandbox environment. This tool is essential for scaffolding applications, adding new features, writing configuration files, or fixing missing components.

All file paths must be relative to the sandbox root (e.g., \`src/index.ts\`, \`package.json\`, \`components/Button.tsx\`).

## When to Use This Tool

Use Generate Files when:

1. You need to create one or more new files as part of a feature, scaffold, or fix
2. The user requests code that implies file creation (e.g., new routes, APIs, components, services)
3. You need to bootstrap a new application structure inside the sandbox environment
4. You're completing a multi-step task that involves generating or updating source code
5. A prior command failed due to a missing file, and you need to supply it

## File Generation Guidelines

- Every file must be complete, valid, and runnable where applicable
- File contents must reflect the user's intent and the overall session context
- File paths must be well-structured and use consistent naming conventions
- Generated files should assume compatibility with other existing files in the sandbox environment

## Best Practices

- Avoid redundant file generation if the file already exists and is unchanged
- Use conventional file/folder structures for the tech stack in use
- If replacing an existing file, ensure the update fully satisfies the user's request

## When NOT to Use This Tool

Avoid using this tool when:

1. You only need to execute code or read files (use Run Command instead)
2. You want to preview a running server or UI (use Run Command to start the server, then Get Sandbox URL)

## Output Behavior

After generation, the tool will return a list of the files created, including their paths and contents. These can then be inspected, referenced, or used in subsequent commands.`;

type Params = {
  db: Db;
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  buildId: string;
};

export const generateFiles = ({ writer, db, buildId }: Params) =>
  tool({
    description,
    inputSchema: z.object({
      sandboxId: z.string(),
      paths: z.array(z.string()),
    }),
    execute: async ({ sandboxId, paths }, { toolCallId, messages }) => {
      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: { paths: [], status: "generating" },
      });

      let sandbox: Sandbox | null = null;

      try {
        sandbox = await Sandbox.get({ sandboxId });
      } catch (error) {
        const richError = getRichError({
          action: "get sandbox by id",
          args: { sandboxId },
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-generating-files",
          data: { error: richError.error, paths: [], status: "error" },
        });

        return richError.message;
      }

      const writeFiles = getWriteFiles({
        sandbox,
        toolCallId,
        writer,
        db,
        buildId,
      });
      const iterator = getContents({ messages, paths });
      const uploaded: File[] = [];

      try {
        for await (const chunk of iterator) {
          if (chunk.files.length > 0) {
            const error = await writeFiles(chunk);
            if (error) {
              return error;
            } else {
              uploaded.push(...chunk.files);
            }
          } else {
            writer.write({
              id: toolCallId,
              type: "data-generating-files",
              data: {
                status: "generating",
                paths: chunk.paths,
              },
            });
          }
        }
      } catch (error) {
        const richError = getRichError({
          action: "generate file contents",
          args: { paths },
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-generating-files",
          data: {
            error: richError.error,
            status: "error",
            paths,
          },
        });

        return richError.message;
      }

      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: { paths: uploaded.map((file) => file.path), status: "done" },
      });

      return `Successfully generated and uploaded ${
        uploaded.length
      } files. Their paths and contents are as follows:
        ${uploaded
          .map((file) => `Path: ${file.path}\nContent: ${file.content}\n`)
          .join("\n")}`;
    },
  });

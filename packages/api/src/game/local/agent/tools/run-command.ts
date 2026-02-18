import type { UIMessage, UIMessageStreamWriter } from "ai";
import type { Command } from "@vercel/sandbox";
import { Sandbox } from "@vercel/sandbox";
import { tool } from "ai";
import z from "zod/v3";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import { getRichError } from "@repo/api/game/local/agent/tools/get-rich-error";

const description = `Execute a shell command inside the Vercel Sandbox environment.

IMPORTANT RULES:
- Each command runs independently in a fresh shell session — there is NO persistent state between commands.
- You CANNOT use 'cd' to change directories for subsequent commands. Instead, use relative or absolute paths.
- Use the 'wait' parameter to control whether the command blocks until completion.
  - wait=true: Blocks until the command finishes, returns stdout/stderr.
  - wait=false: Starts the command in the background (e.g., dev servers).
- Common usage patterns:
  - Install dependencies: command="npm", args=["install"], wait=true
  - Start dev server: command="npm", args=["run", "dev"], wait=false
  - Run a script: command="node", args=["src/index.js"], wait=true
  - List files: command="ls", args=["-la", "./src"], wait=true
- When starting a dev server, always use wait=false so it runs in the background.
- After starting a dev server, use the getSandboxURL tool to get the public URL.`;

type Params = {
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
};

export const runCommand = ({ writer }: Params) =>
  tool({
    description,
    inputSchema: z.object({
      sandboxId: z
        .string()
        .describe("The ID of the Vercel Sandbox to run the command in"),
      command: z
        .string()
        .describe(
          "The base command to run (e.g., 'npm', 'node', 'python', 'ls', 'cat'). Do NOT include arguments here.",
        ),
      args: z
        .array(z.string())
        .optional()
        .describe(
          "Array of arguments for the command. Each argument should be a separate string (e.g., ['install', '--verbose'] for npm install --verbose).",
        ),
      sudo: z
        .boolean()
        .optional()
        .describe("Whether to run the command with sudo"),
      wait: z
        .boolean()
        .describe(
          "Whether to wait for the command to finish before returning. If true, the command will block until it completes, and you will receive its output.",
        ),
    }),
    execute: async (
      { sandboxId, command, sudo, wait, args = [] },
      { toolCallId },
    ) => {
      writer.write({
        id: toolCallId,
        type: "data-run-command",
        data: { sandboxId, command, args, status: "executing" },
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
          type: "data-run-command",
          data: {
            sandboxId,
            command,
            args,
            error: richError.error,
            status: "error",
          },
        });

        return richError.message;
      }

      let cmd: Command | null = null;

      try {
        cmd = await sandbox.runCommand({
          detached: true,
          cmd: command,
          args,
          sudo,
        });
      } catch (error) {
        const richError = getRichError({
          action: "run command in sandbox",
          args: { sandboxId },
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-run-command",
          data: {
            sandboxId,
            command,
            args,
            error: richError.error,
            status: "error",
          },
        });

        return richError.message;
      }

      writer.write({
        id: toolCallId,
        type: "data-run-command",
        data: {
          sandboxId,
          commandId: cmd.cmdId,
          command,
          args,
          status: "executing",
        },
      });

      if (!wait) {
        writer.write({
          id: toolCallId,
          type: "data-run-command",
          data: {
            sandboxId,
            commandId: cmd.cmdId,
            command,
            args,
            status: "running",
          },
        });

        return `The command \`${command} ${args.join(
          " ",
        )}\` has been started in the background in the sandbox with ID \`${sandboxId}\` with the commandId ${
          cmd.cmdId
        }.`;
      }

      writer.write({
        id: toolCallId,
        type: "data-run-command",
        data: {
          sandboxId,
          commandId: cmd.cmdId,
          command,
          args,
          status: "waiting",
        },
      });

      const done = await cmd.wait();
      try {
        const [stdout, stderr] = await Promise.all([
          done.stdout(),
          done.stderr(),
        ]);

        writer.write({
          id: toolCallId,
          type: "data-run-command",
          data: {
            sandboxId,
            commandId: cmd.cmdId,
            command,
            args,
            exitCode: done.exitCode,
            status: "done",
          },
        });

        return (
          `The command \`${command} ${args.join(
            " ",
          )}\` has finished with exit code ${done.exitCode}.` +
          `Stdout of the command was: \n` +
          `\`\`\`\n${stdout}\n\`\`\`\n` +
          `Stderr of the command was: \n` +
          `\`\`\`\n${stderr}\n\`\`\``
        );
      } catch (error) {
        const richError = getRichError({
          action: "wait for command to finish",
          args: { sandboxId, commandId: cmd.cmdId },
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-run-command",
          data: {
            sandboxId,
            commandId: cmd.cmdId,
            command,
            args,
            error: richError.error,
            status: "error",
          },
        });

        return richError.message;
      }
    },
  });

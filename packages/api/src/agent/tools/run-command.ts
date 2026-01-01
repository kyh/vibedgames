import type { UIMessage, UIMessageStreamWriter } from "ai";
import type { Sandbox, SandboxCommand } from "just-bash";
import { tool } from "ai";
import z from "zod/v3";

import type { DataPart } from "../messages/data-parts";
import { getRichError } from "./get-rich-error";

const description = `Use this tool to run bash commands in the in-memory sandbox environment. Commands always run to completion before returning results.

⚠️ Commands are stateless — each one runs in a fresh shell session with **no memory** of previous commands. You CANNOT rely on \`cd\` to change directories for subsequent commands.

## When to Use This Tool

Use Run Command when:

1. You need to read file contents (e.g., \`cat package.json\`, \`head src/index.ts\`)
2. You want to list directory contents (e.g., \`ls -la\`, \`find . -name "*.ts"\`)
3. You need to check file information (e.g., \`stat file.txt\`, \`file image.png\`)
4. You want to process text with standard Unix tools (e.g., \`grep pattern file.txt\`, \`wc -l file.txt\`)
5. You need to run simple bash utilities for file operations

## When NOT to Use This Tool

- **DO NOT** use this tool to install dependencies. Instead, modify \`package.json\` using Generate Files and let Sandpack handle installation automatically.
- **DO NOT** use this tool to run build commands. Sandpack handles bundling automatically.
- **DO NOT** use this tool to start development servers. The app renders in Sandpack automatically.

## Command Format

- Provide the complete command as a single string including all arguments
  - ✅ \`{ command: "cat package.json" }\`
  - ✅ \`{ command: "ls -la src" }\`
  - ✅ \`{ command: "grep -r 'import' src/" }\`
  - ❌ \`{ command: "cat", args: ["package.json"] }\` (don't separate command and args)
- Use full relative paths from the /app directory (sandbox starts in /app)
  - ✅ \`{ command: "cat src/index.ts" }\` (reads from /app/src/index.ts)
  - ✅ \`{ command: "ls -la" }\` (lists /app directory)
  - ❌ \`{ command: "cd src && cat index.ts" }\` (cd doesn't persist)

## Examples

<example>
User: Show me the contents of package.json  
Assistant:  
Run Command: \`{ command: "cat package.json" }\`  
</example>

<example>
User: List all TypeScript files in the src directory  
Assistant:  
Run Command: \`{ command: "find src -name '*.ts' -o -name '*.tsx'" }\`  
</example>

<example>
User: Check if there are any console.log statements in the code  
Assistant:  
Run Command: \`{ command: "grep -r 'console.log' src/" }\`  
</example>

## Summary

Use Run Command to execute bash commands for reading files, listing directories, and using standard Unix text processing tools. Commands always complete before returning results. For installing dependencies or building, modify package.json instead.`;

type Params = {
  sandbox: Sandbox;
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
};

export const runCommand = ({ sandbox, writer }: Params) =>
  tool({
    description,
    inputSchema: z.object({
      command: z
        .string()
        .describe(
          "The complete command to run as a single string, including all arguments (e.g., 'cat package.json', 'ls -la src', 'grep pattern file.txt'). IMPORTANT: Each command runs independently in a fresh shell session - there is no persistent state between commands. You cannot use 'cd' to change directories for subsequent commands. Use full relative paths from the sandbox root.",
        ),
    }),
    execute: async ({ command }, { toolCallId }) => {
      writer.write({
        id: toolCallId,
        type: "data-run-command",
        data: { command, status: "executing" },
      });

      let cmd: SandboxCommand | null = null;

      try {
        cmd = await sandbox.runCommand(command);
      } catch (error) {
        const richError = getRichError({
          action: "run command in sandbox",
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-run-command",
          data: {
            command,
            error: richError.error,
            status: "error",
          },
        });

        return richError.message;
      }

      try {
        const done = await cmd.wait();
        const [stdout, stderr] = await Promise.all([
          done.stdout(),
          done.stderr(),
        ]);

        writer.write({
          id: toolCallId,
          type: "data-run-command",
          data: {
            command,
            exitCode: done.exitCode,
            status: "done",
          },
        });

        return (
          `The command \`${command}\` has finished with exit code ${done.exitCode}.` +
          (stdout
            ? `\nStdout of the command was: \n\`\`\`\n${stdout}\n\`\`\``
            : "") +
          (stderr
            ? `\nStderr of the command was: \n\`\`\`\n${stderr}\n\`\`\``
            : "")
        );
      } catch (error) {
        const richError = getRichError({
          action: "wait for command to finish",
          args: { command },
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-run-command",
          data: {
            command,
            error: richError.error,
            status: "error",
          },
        });

        return richError.message;
      }
    },
  });

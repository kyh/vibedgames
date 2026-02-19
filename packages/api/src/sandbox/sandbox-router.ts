import { Sandbox } from "@vercel/sandbox";

import { createTRPCRouter, publicProcedure } from "../trpc";
import {
  commandParamsSchema,
  fileParamsSchema,
  sandboxIdSchema,
} from "./sandbox-schema";

export const sandboxRouter = createTRPCRouter({
  status: publicProcedure.input(sandboxIdSchema).query(async ({ input }) => {
    try {
      const sandbox = await Sandbox.get({ sandboxId: input.sandboxId });
      await sandbox.runCommand({
        cmd: "echo",
        args: ["Sandbox status check"],
      });
      return { status: "running" as const };
    } catch (error) {
      const isSandboxStopped =
        error instanceof Error &&
        "json" in error &&
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        (error as Record<string, any>).json?.error?.code === "sandbox_stopped";
      if (isSandboxStopped) {
        return { status: "stopped" as const };
      } else {
        throw error;
      }
    }
  }),

  getFile: publicProcedure.input(fileParamsSchema).query(async ({ input }) => {
    const sandbox = await Sandbox.get(input);
    const stream = await sandbox.readFile(input);
    if (!stream) {
      throw new Error("File not found in the Sandbox");
    }

    // Convert stream to string for tRPC
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }),

  getCommand: publicProcedure
    .input(commandParamsSchema)
    .query(async ({ input }) => {
      const sandbox = await Sandbox.get(input);
      const command = await sandbox.getCommand(input.cmdId);

      /**
       * The wait can fail when the Sandbox is stopped but the command
       * was still running. In such case we return empty for finish data.
       */
      const done = await command.wait().catch(() => null);

      return {
        sandboxId: sandbox.sandboxId,
        cmdId: command.cmdId,
        startedAt: command.startedAt,
        exitCode: done?.exitCode,
      };
    }),

  getCommandLogs: publicProcedure
    .input(commandParamsSchema)
    .query(async ({ input }) => {
      const sandbox = await Sandbox.get(input);
      const command = await sandbox.getCommand(input.cmdId);

      // Collect all logs for tRPC response
      const logs = [];
      for await (const logline of command.logs()) {
        logs.push({
          data: logline.data,
          stream: logline.stream,
          timestamp: Date.now(),
        });
      }
      return logs;
    }),
});

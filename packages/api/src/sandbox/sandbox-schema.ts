import { z } from "zod";

export const sandboxIdSchema = z.object({
  sandboxId: z.string(),
});
export type SandboxIdSchema = z.infer<typeof sandboxIdSchema>;

export const fileParamsSchema = z.object({
  sandboxId: z.string(),
  path: z.string(),
});
export type FileParamsSchema = z.infer<typeof fileParamsSchema>;

export const commandParamsSchema = z.object({
  sandboxId: z.string(),
  cmdId: z.string(),
});
export type CommandParamsSchema = z.infer<typeof commandParamsSchema>;

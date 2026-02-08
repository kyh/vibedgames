import z from "zod";

export const errorSchema = z.object({
  message: z.string(),
});

export const dataPartSchema = z.object({
  "generating-files": z.object({
    files: z
      .array(
        z.object({
          path: z.string(),
          content: z.string(),
        }),
      )
      .optional(),
    paths: z.array(z.string()),
    status: z.enum(["generating", "uploading", "uploaded", "done", "error"]),
    error: errorSchema.optional(),
  }),
  "run-command": z.object({
    command: z.string(),
    status: z.enum(["executing", "running", "waiting", "done", "error"]),
    exitCode: z.number().optional(),
    error: errorSchema.optional(),
  }),
  "report-errors": z.object({
    summary: z.string(),
    paths: z.array(z.string()).optional(),
  }),
  "v0-preview": z.object({
    chatId: z.string(),
    url: z.string().optional(),
    files: z
      .array(
        z.object({
          name: z.string(),
          content: z.string(),
        }),
      )
      .optional(),
    status: z.enum(["streaming", "done", "error"]),
    error: errorSchema.optional(),
  }),
});

export type DataPart = z.infer<typeof dataPartSchema>;

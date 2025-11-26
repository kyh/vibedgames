import z from "zod";

export const errorSchema = z.object({
  message: z.string(),
});

export const fileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const dataPartSchema = z.object({
  // Project metadata for persistence
  "project-metadata": z.object({
    projectId: z.string().optional(),
    buildNumber: z.number().optional(),
    status: z.enum(["loading", "done", "error"]),
    error: errorSchema.optional(),
  }),
  // File generation progress
  "generating-files": z.object({
    paths: z.array(z.string()),
    status: z.enum(["generating", "done", "error"]),
    error: errorSchema.optional(),
  }),
  // Streamed file contents for sandpack
  "file-content": z.object({
    files: z.array(fileContentSchema),
    status: z.enum(["streaming", "done", "error"]),
    error: errorSchema.optional(),
  }),
  // Error reporting
  "report-errors": z.object({
    summary: z.string(),
    paths: z.array(z.string()).optional(),
  }),
});

export type DataPart = z.infer<typeof dataPartSchema>;

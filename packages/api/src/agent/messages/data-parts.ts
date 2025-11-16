import z from "zod";

export const errorSchema = z.object({
  message: z.string(),
});

export const fileDataSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const dataPartSchema = z.object({
  "workspace": z.object({
    status: z.enum(["loading", "ready", "error"]),
    projectId: z.string().optional(),
    buildNumber: z.number().optional(),
    files: z.array(fileDataSchema).optional(),
    error: errorSchema.optional(),
  }),
  "generating-files": z.object({
    paths: z.array(z.string()),
    status: z.enum(["generating", "streaming", "done", "error"]),
    files: z.array(fileDataSchema).optional(),
    error: errorSchema.optional(),
  }),
  "report-errors": z.object({
    summary: z.string(),
    paths: z.array(z.string()).optional(),
  }),
});

export type DataPart = z.infer<typeof dataPartSchema>;
export type DataPartFile = z.infer<typeof fileDataSchema>;

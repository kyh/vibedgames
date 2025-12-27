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
  "report-errors": z.object({
    summary: z.string(),
    paths: z.array(z.string()).optional(),
  }),
});

export type DataPart = z.infer<typeof dataPartSchema>;

import { z } from "zod";

export const errorRequestSchema = z.object({
  lines: z.array(z.string()),
});
export type ErrorRequestSchema = z.infer<typeof errorRequestSchema>;

export const errorResponseSchema = z.object({
  shouldBeFixed: z.boolean(),
  summary: z.string(),
});
export type ErrorResponseSchema = z.infer<typeof errorResponseSchema>;

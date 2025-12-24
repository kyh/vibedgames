import { z } from "zod";

export const listBuildsInput = z.object({
  limit: z.number().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

export const getBuildInput = z.object({
  buildId: z.string().min(1, "buildId is required"),
});

export const createBuildInput = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  organizationId: z.string().optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1, "path is required"),
        content: z.string(),
      }),
    )
    .min(1, "At least one file is required"),
});

export const updateBuildFilesInput = z.object({
  buildId: z.string().min(1, "buildId is required"),
  files: z
    .array(
      z.object({
        path: z.string().min(1, "path is required"),
        content: z.string(),
      }),
    )
    .min(1, "At least one file is required"),
});

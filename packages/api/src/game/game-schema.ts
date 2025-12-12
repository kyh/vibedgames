import { z } from "zod";

export const listBuildsInput = z.object({
  projectId: z.string().min(1, "projectId is required"),
  limit: z.number().min(1).max(50).optional(),
  cursor: z.number().optional(),
});

export const getProjectInput = z.object({
  projectId: z.string().min(1, "projectId is required"),
});

export const getBuildSnapshotInput = z.object({
  projectId: z.string().min(1, "projectId is required"),
  buildNumber: z.number().min(1, "buildNumber is required"),
});

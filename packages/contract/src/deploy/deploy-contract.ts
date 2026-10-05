import { z } from "zod";

import { protectedBase } from "../base";
import { mcpTool } from "../mcp";
import { documented } from "../openapi";
import { createInput, deleteInput, finalizeInput, getSourceInput } from "./deploy-schema";

const presignedUpload = z.object({
  headers: z.object({ "content-type": z.string() }),
  url: z.string(),
});

const createOutput = z.object({
  deploymentId: z.string(),
  gameId: z.string(),
  sourceUpload: presignedUpload.nullable(),
  uploads: z.array(presignedUpload.extend({ path: z.string() })),
});

const deploymentSummary = z.object({
  createdAt: z.date(),
  fileCount: z.number().int(),
  id: z.string(),
  status: z.enum(["pending", "ready", "failed"]),
  totalBytes: z.number().int(),
});

const gameSummary = z.object({
  createdAt: z.date(),
  currentDeploymentId: z.string().nullable(),
  deployment: deploymentSummary.nullable(),
  id: z.string(),
  name: z.string().nullable(),
  slug: z.string(),
  updatedAt: z.date(),
  userId: z.string(),
});

export const deployContract = {
  create: protectedBase
    .meta(mcpTool({ access: "write", title: "Start a deployment" }))
    .meta(
      documented({
        description:
          "Starts a deployment of a built game to `{slug}.vibedgames.com`, replacing the previous one. Returns a presigned PUT URL per file (and for the optional source archive); upload each, then call deploy.finalize. 403 when the slug belongs to someone else.",
        errors: [403],
        summary: "Create a deployment",
      }),
    )
    .input(createInput)
    .output(createOutput),

  delete: protectedBase
    .meta(mcpTool({ access: "destructive", title: "Delete a game" }))
    .meta(
      documented({
        description: "Permanently deletes one of the caller's games and all of its deployed files.",
        errors: [404],
        summary: "Delete a game",
      }),
    )
    .input(deleteInput)
    .output(z.object({ success: z.literal(true) })),

  finalize: protectedBase
    .meta(mcpTool({ access: "write", title: "Finalize a deployment" }))
    .meta(
      documented({
        description:
          "Marks an uploaded deployment ready and makes it the live version of its game. Returns the public URL.",
        errors: [403, 404],
        summary: "Finalize a deployment",
      }),
    )
    .input(finalizeInput)
    .output(z.object({ slug: z.string(), url: z.string() })),

  getSource: protectedBase
    .meta(mcpTool({ access: "read", title: "Get a game's source" }))
    .meta(
      documented({
        description:
          "Returns a one-hour download URL for a game's forkable source archive. Any signed-in user may fork any game that shipped source. Backs `vg fork`.",
        errors: [404],
        summary: "Get a game's source",
      }),
    )
    .input(getSourceInput)
    .output(
      z.object({
        bytes: z.number().int().nullable(),
        name: z.string().nullable(),
        slug: z.string(),
        url: z.string(),
      }),
    ),

  list: protectedBase
    .meta(mcpTool({ access: "read", title: "List your games" }))
    .meta(
      documented({
        description:
          "Lists the caller's games, most recently updated first, each with its live deployment.",
        summary: "List your games",
      }),
    )
    .output(z.object({ games: z.array(gameSummary) })),
};

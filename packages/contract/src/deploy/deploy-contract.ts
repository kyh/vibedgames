import { z } from "zod";

import { protectedBase } from "../base";
import { documented } from "../openapi";
import {
  createInput,
  deleteInput,
  finalizeInput,
  getSourceInput,
  uploadInput,
} from "./deploy-schema";

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
    .meta(
      documented({
        description:
          "Legacy: what `vg` up to this release called; use deploy.upload. Starts a deployment of a built game to `{slug}.vibedgames.com`, replacing the previous one at once. Returns a signed PUT URL per file (and for the optional source archive); upload each, then call deploy.finalize. 403 when the slug belongs to someone else.",
        errors: [403],
        summary: "Create a deployment",
      }),
    )
    .input(createInput)
    .output(createOutput),

  delete: protectedBase
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
    .meta(
      documented({
        description:
          "Legacy, with deploy.create: marks an uploaded deployment ready and makes it the live version of its game. Returns the public URL.",
        errors: [403, 404],
        summary: "Finalize a deployment",
      }),
    )
    .input(finalizeInput)
    .output(z.object({ slug: z.string(), url: z.string() })),

  getSource: protectedBase
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
    .meta(
      documented({
        description:
          "Lists the caller's games, most recently updated first, each with its live deployment.",
        summary: "List your games",
      }),
    )
    .output(z.object({ games: z.array(gameSummary) })),

  upload: protectedBase
    .meta(
      documented({
        description:
          "Deploys a game. The usual way: pass `bundle: true`, PUT a gzipped tar of the built game (`tar -czf game.tgz -C dist .`, `index.html` at its root) to the `bundleUpload` URL it returns, then call again with the `deploymentId` and `publish: true`; publish unpacks it. Files can also be given one by one: `files` carries `utf-8` text, or with `encoding: url` the URL of an asset generate made, which the server fetches itself (up to 32 MB a call); `presign` takes a file's path, size and SHA-256 and returns a signed PUT URL for it in `uploads`. Upload URLs are on this server and last 15 minutes. A call without `deploymentId` stages a new deployment beside the live one; later calls pass it back to add or replace files. `publish: true` requires `index.html` and every presigned file at its declared size, makes the deployment live at `{slug}.vibedgames.com` and only then removes the previous one, so the game never goes dark mid-upload. With `source: true` publish also keeps the deployment's files as the game's forkable source (up to 64 MB); a caller with its own source archive passes `sourceArchive` instead and PUTs it to `sourceUpload`. 403 when the slug belongs to someone else.",
        errors: [403, 404],
        summary: "Upload files inline and deploy",
      }),
    )
    .input(uploadInput)
    .output(
      z.object({
        bundleUpload: presignedUpload.nullable(),
        deploymentId: z.string(),
        fileCount: z.number().int(),
        gameId: z.string(),
        published: z.boolean(),
        sourceUpload: presignedUpload.nullable(),
        totalBytes: z.number().int(),
        uploads: z.array(presignedUpload.extend({ path: z.string() })),
        url: z.string().nullable(),
      }),
    ),
};

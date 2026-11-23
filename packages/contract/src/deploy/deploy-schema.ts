import { z } from "zod";

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_TOTAL_SIZE = 200 * 1024 * 1024;
export const MAX_FILE_COUNT = 500;
export const MAX_SOURCE_SIZE = 100 * 1024 * 1024;
export const MAX_UPLOAD_BODY = 100 * 1024 * 1024;

const slugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/u, {
    message: "slug must be lowercase alphanumeric with hyphens",
  });

export const fileSchema = z.object({
  contentType: z.string().min(1).max(127),
  path: z
    .string()
    .min(1)
    .max(512)
    .refine((p) => !p.startsWith("/"), "path must be relative")
    .refine((p) => !p.includes(".."), "path must not contain ..")
    .describe(
      "The file's path from the game's root, e.g. `index.html` or `assets/hero.png`; no leading `/` and no `..`",
    ),
  sha256: z
    .string()
    .length(64)
    .describe("The SHA-256 of the file's bytes as 64 hex characters, as `sha256sum` prints it"),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_FILE_SIZE)
    .describe(
      `The file's exact size in bytes, at most ${MAX_FILE_SIZE} (10 MB); publish checks the uploaded file has this size`,
    ),
});

export const createInput = z.object({
  files: z.array(fileSchema).min(1).max(MAX_FILE_COUNT),
  name: z.string().max(120).optional(),
  slug: slugSchema,
  source: z
    .object({
      bytes: z.number().int().positive().max(MAX_SOURCE_SIZE),
      sha256: z.string().length(64),
    })
    .optional(),
});

export const finalizeInput = z.object({
  deploymentId: z.string(),
});

export const deleteInput = z.object({
  gameId: z
    .string()
    .describe(
      "The id of one of your games: a game's `id` in the deployments list, or the `gameId` deploy returned",
    ),
});

export const getSourceInput = z.object({
  slug: slugSchema.describe(
    "The slug of the game to fork, as in its address `{slug}.vibedgames.com`, e.g. `space-pong`; any game deployed with source can be forked",
  ),
});

const inlineFileSchema = z.object({
  content: z.string().describe("The file's text, or with `encoding: url` a generated asset's URL"),
  contentType: z
    .string()
    .min(1)
    .max(127)
    .optional()
    .describe(
      "The MIME type to serve the file with, e.g. `text/html; charset=utf-8`; omit to infer it from the path's extension",
    ),
  encoding: z
    .enum(["utf-8", "url"])
    .default("utf-8")
    .describe(
      "How to read `content`: `utf-8` (the default) stores it as the file's text; `url` fetches it from a URL a generate tool returned (other hosts are refused), up to 10 MB a file and 32 MB a call",
    ),
  path: fileSchema.shape.path,
});

export type InlineFile = z.infer<typeof inlineFileSchema>;

const presignedFileSchema = fileSchema.extend({
  contentType: fileSchema.shape.contentType
    .optional()
    .describe(
      "The MIME type to serve the file with, and the Content-Type to PUT it with, e.g. `image/png`; omit to infer it from the path's extension",
    ),
});

export type PresignedFile = z.infer<typeof presignedFileSchema>;

export const uploadInput = z.object({
  bundle: z
    .boolean()
    .default(false)
    .describe(
      "true returns a `bundleUpload` URL to PUT the whole built game to as one gzipped tar, `index.html` at its root (`tar -czf game.tgz -C dist .`); a later call with `publish: true` unpacks it. The usual way in. Default false",
    ),
  deploymentId: z
    .string()
    .optional()
    .describe(
      "The `deploymentId` an earlier deploy call for this slug returned, to add files to that staged deployment or publish it; omit to stage a new one",
    ),
  files: z
    .array(inlineFileSchema)
    .max(MAX_FILE_COUNT)
    .default([])
    .describe(
      "Files sent in the call itself: text, or a generated asset's URL with `encoding: url`. A path already staged is replaced. Default none",
    ),
  name: z
    .string()
    .max(120)
    .optional()
    .describe(
      "The game's display name, up to 120 characters, e.g. `Space Pong`; omit to keep the name it has",
    ),
  presign: z
    .array(presignedFileSchema)
    .max(MAX_FILE_COUNT)
    .default([])
    .describe(
      "Files you PUT yourself: each returns a signed URL in `uploads`, valid 15 minutes, to PUT its bytes to with the `headers` given; list a file again to renew its URL. Default none",
    ),
  publish: z
    .boolean()
    .default(false)
    .describe(
      "true makes the staged deployment live at `{slug}.vibedgames.com` once this call's files are in (it needs `index.html` and every presigned file at its declared size), then removes the previous one. Default false: the files stay staged",
    ),
  slug: slugSchema.describe(
    "The game's slug, which makes its address `{slug}.vibedgames.com`: 3 to 40 lowercase letters, digits and hyphens, no hyphen at either end, e.g. `space-pong`. A new slug becomes your game, one another account owns is refused; pass the same one on every call of a deployment",
  ),
  source: z
    .boolean()
    .default(false)
    .describe(
      "With `publish: true`, also keep the deployment's files (up to 64 MB) as the game's forkable source, which fork downloads. Default false; not with `sourceArchive`",
    ),
  sourceArchive: z
    .object({
      bytes: z
        .number()
        .int()
        .positive()
        .max(MAX_SOURCE_SIZE)
        .describe(
          `The archive's exact size in bytes, at most ${MAX_SOURCE_SIZE} (100 MB); publish checks the upload has this size`,
        ),
      sha256: z
        .string()
        .length(64)
        .describe("The SHA-256 of the archive's bytes as 64 hex characters"),
    })
    .optional()
    .describe(
      "Your own forkable source archive (a .tar.gz of the project, what `vg deploy --source` packs), which you PUT to the `sourceUpload` URL this call returns; omit for none. Not with `source: true`",
    ),
});

import { z } from "zod";

// ---- Limits ----------------------------------------------------------------
// (raised 2026-07-06 for baked-world games; see crazy-waymo world artifacts)

// Sized for real games: baked-world data files (crazy-waymo ships a ~62MB
// pre-generated city) blow past web-app-scale caps. R2 storage is cheap and
// single-active-deployment means old blobs are replaced, not accumulated.
// 10 MB per file (big data ships as parts)
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
// 200 MB per deploy
export const MAX_TOTAL_SIZE = 200 * 1024 * 1024;
export const MAX_FILE_COUNT = 500;
// 100 MB for the forkable source archive
export const MAX_SOURCE_SIZE = 100 * 1024 * 1024;

// ---- Schemas -----------------------------------------------------------------

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
    .refine((p) => !p.includes(".."), "path must not contain .."),
  sha256: z.string().length(64),
  size: z.number().int().nonnegative().max(MAX_FILE_SIZE),
});

export const createInput = z.object({
  files: z.array(fileSchema).min(1).max(MAX_FILE_COUNT),
  name: z.string().max(120).optional(),
  slug: slugSchema,
  // Optional forkable source archive (tar.gz). When present we mint a second
  // presigned PUT for it under the `sources/` prefix and record its metadata.
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
  gameId: z.string(),
});

export const getSourceInput = z.object({ slug: slugSchema });

/**
 * One file of a `deploy.upload` call: carried in the request as `utf-8` text
 * or `base64` bytes, or, as `url`, a generated asset's URL the server fetches
 * itself, so an agent with no disk can deploy what generate made. The type is
 * the path's unless given.
 */
const inlineFileSchema = z.object({
  content: z
    .string()
    .describe("The file: text, base64, or with `encoding: url` a generated asset's URL"),
  contentType: z.string().min(1).max(127).optional(),
  encoding: z.enum(["utf-8", "base64", "url"]).default("utf-8"),
  path: fileSchema.shape.path,
});

export type InlineFile = z.infer<typeof inlineFileSchema>;

export const uploadInput = z.object({
  /** Continue a staged deployment this call's earlier upload returned; omit to start one. */
  deploymentId: z.string().optional(),
  files: z.array(inlineFileSchema).max(MAX_FILE_COUNT).default([]),
  name: z.string().max(120).optional(),
  /** Make the staged deployment live once these files are in. */
  publish: z.boolean().default(false),
  slug: slugSchema,
  /** On publish, also keep the deployment's files as its forkable source. */
  source: z.boolean().default(false),
});

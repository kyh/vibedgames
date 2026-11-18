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
    .refine((p) => !p.includes(".."), "path must not contain .."),
  sha256: z.string().length(64),
  size: z.number().int().nonnegative().max(MAX_FILE_SIZE),
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
  gameId: z.string(),
});

export const getSourceInput = z.object({ slug: slugSchema });

const inlineFileSchema = z.object({
  content: z.string().describe("The file's text, or with `encoding: url` a generated asset's URL"),
  contentType: z.string().min(1).max(127).optional(),
  encoding: z.enum(["utf-8", "url"]).default("utf-8"),
  path: fileSchema.shape.path,
});

export type InlineFile = z.infer<typeof inlineFileSchema>;

const presignedFileSchema = fileSchema.extend({
  contentType: fileSchema.shape.contentType.optional(),
});

export type PresignedFile = z.infer<typeof presignedFileSchema>;

export const uploadInput = z.object({
  /**
   * The game as one gzipped tar of its built files, `index.html` at the root
   * (`tar -czf game.tgz -C dist .`): the call returns a `bundleUpload` URL to
   * PUT it to, and publish unpacks it into the deployment. The usual way in.
   */
  bundle: z.boolean().default(false),
  /** Continue a staged deployment this call's earlier upload returned; omit to start one. */
  deploymentId: z.string().optional(),
  files: z.array(inlineFileSchema).max(MAX_FILE_COUNT).default([]),
  name: z.string().max(120).optional(),
  /** Files the caller PUTs itself, to the URLs this call returns. */
  presign: z.array(presignedFileSchema).max(MAX_FILE_COUNT).default([]),
  /** Make the staged deployment live once these files are in. */
  publish: z.boolean().default(false),
  slug: slugSchema,
  /** On publish, also keep the deployment's files as its forkable source. */
  source: z.boolean().default(false),
  /**
   * A forkable source archive (tar.gz) the caller PUTs itself, to the
   * `sourceUpload` URL this call returns: what `vg deploy --source` packs from
   * the project rather than the built files `source` keeps.
   */
  sourceArchive: z
    .object({
      bytes: z.number().int().positive().max(MAX_SOURCE_SIZE),
      sha256: z.string().length(64),
    })
    .optional(),
});

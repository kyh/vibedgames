import { and, count, eq, inArray, sql, sum } from "@repo/db";
import { deployment, deploymentFile, game } from "@repo/db/drizzle-schema";
import type { PresignedFile } from "@repo/contract/deploy/deploy-schema";
import { runInOrder } from "@repo/contract/run-in-order";
import { contentTypeForPath } from "@repo/contract/deploy/content-types";
import { gameOrigin } from "@repo/contract/deploy/game-origin";
import type { Db } from "@repo/db/drizzle-client";
import {
  fileSchema,
  MAX_FILE_COUNT,
  MAX_FILE_SIZE,
  MAX_SOURCE_SIZE,
  MAX_TOTAL_SIZE,
} from "@repo/contract/deploy/deploy-schema";
import { ORPCError } from "@orpc/server";
import type { z } from "zod";

import { os, requireSession } from "../orpc";
import type { DecodedFile } from "./inline-files";
import { decodeInlineFiles, sha256Hex } from "./inline-files";
import type { R2Config, UrlSigning } from "../storage/signed-urls";
import { deletePrefix, signDownloadUrl, signUploadUrl } from "../storage/signed-urls";
import { forEachBundleFile } from "./bundle-extract";
import { sourceArchive } from "./source-archive";
import { isSlugReserved } from "./reserved-slugs";

const sourceKeyFor = (gameId: string, deploymentId: string) =>
  `sources/${gameId}/${deploymentId}/source.tgz`;

const bundleKeyFor = (gameId: string, deploymentId: string) =>
  `bundles/${gameId}/${deploymentId}.tgz`;

const requireR2 = (r2: R2Config | undefined) => {
  if (!r2) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "R2 is not configured on this worker.",
    });
  }

  return r2;
};

const requireSigning = (signing: UrlSigning | undefined) => {
  if (!signing) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Upload URLs are not configured on this worker.",
    });
  }

  return signing;
};

const validateManifest = (files: z.infer<typeof fileSchema>[]) => {
  const hasIndex = files.some((f) => f.path === "index.html");

  if (!hasIndex) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Deployment must contain index.html at the root.",
    });
  }

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

  if (totalBytes > MAX_TOTAL_SIZE) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Total deploy size ${totalBytes} exceeds limit ${MAX_TOTAL_SIZE}.`,
    });
  }

  const paths = new Set<string>();

  for (const f of files) {
    if (paths.has(f.path)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Duplicate path "${f.path}" in manifest.`,
      });
    }

    paths.add(f.path);
  }

  return totalBytes;
};

const INSERT_BATCH_SIZE = 10;

const publicGameUrl = (productionURL: string | undefined, slug: string) =>
  gameOrigin(productionURL ?? "https://www.vibedgames.com", slug);

const claimGame = async (
  db: Db,
  userId: string,
  { create = true, name, slug }: { create?: boolean; name?: string; slug: string },
) => {
  let row = await db.query.game.findFirst({ where: { slug } });

  if (!row && !create) {
    throw new ORPCError("NOT_FOUND", { message: "Deployment not found." });
  }

  if (!row) {
    await db
      .insert(game)
      .values({ id: crypto.randomUUID(), name: name ?? null, slug, userId })
      .onConflictDoNothing({ target: game.slug });
    row = await db.query.game.findFirst({ where: { slug } });
  }

  if (row?.userId !== userId) {
    throw new ORPCError("FORBIDDEN", { message: `Slug "${slug}" is already taken.` });
  }

  if (name !== undefined && name !== "" && name !== row.name) {
    await db.update(game).set({ name }).where(eq(game.id, row.id));
  }

  return row;
};

const stageDeployment = async (db: Db, gameId: string, deploymentId: string | undefined) => {
  if (deploymentId === undefined) {
    const id = crypto.randomUUID();
    await db
      .insert(deployment)
      .values({ fileCount: 0, gameId, id, status: "pending", totalBytes: 0 });

    return id;
  }

  const staged = await db.query.deployment.findFirst({ where: { gameId, id: deploymentId } });

  if (!staged) {
    throw new ORPCError("NOT_FOUND", {
      message: "Deployment not found: start a new upload without a deploymentId.",
    });
  }

  if (staged.status !== "pending") {
    throw new ORPCError("BAD_REQUEST", { message: `Deployment already ${staged.status}.` });
  }

  return staged.id;
};

const deploymentTotals = async (db: Db, deploymentId: string) => {
  const [row] = await db
    .select({ bytes: sum(deploymentFile.size), files: count() })
    .from(deploymentFile)
    .where(eq(deploymentFile.deploymentId, deploymentId));

  return { bytes: Number(row?.bytes ?? 0), files: row?.files ?? 0 };
};

const assertDistinctPaths = (files: DecodedFile[], presign: PresignedFile[]) => {
  const seen = new Set(files.map((f) => f.path));

  for (const f of presign) {
    if (seen.has(f.path)) {
      throw new ORPCError("BAD_REQUEST", { message: `Duplicate path "${f.path}" in upload.` });
    }

    seen.add(f.path);
  }
};

const assertUploadBudget = (
  staged: { bytes: number; files: number },
  files: DecodedFile[],
  presign: PresignedFile[],
) => {
  const incoming =
    files.reduce((acc, f) => acc + f.bytes.byteLength, 0) +
    presign.reduce((acc, f) => acc + f.size, 0);

  if (staged.bytes + incoming > MAX_TOTAL_SIZE) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Deployment would exceed the ${MAX_TOTAL_SIZE}-byte limit.`,
    });
  }

  if (staged.files + files.length + presign.length > MAX_FILE_COUNT) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Deployment would exceed ${MAX_FILE_COUNT} files.`,
    });
  }
};

type FileRow = typeof deploymentFile.$inferInsert;

const batchesOf = <T>(items: readonly T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

const upsertFileRows = async (db: Db, rows: FileRow[]) => {
  await runInOrder(batchesOf(rows, INSERT_BATCH_SIZE), async (batch) => {
    await db
      .insert(deploymentFile)
      .values(batch)
      .onConflictDoUpdate({
        set: {
          contentType: sql`excluded.content_type`,
          sha256: sql`excluded.sha256`,
          size: sql`excluded.size`,
        },
        target: [deploymentFile.deploymentId, deploymentFile.path],
      });
  });
};

const writeUploadedFiles = async (
  db: Db,
  r2: R2Config,
  { deploymentId, files, gameId }: { deploymentId: string; files: DecodedFile[]; gameId: string },
) => {
  const rows = await Promise.all(
    files.map(async (f) => {
      const r2Key = `games/${gameId}/${deploymentId}/${f.path}`;
      await r2.bucket.put(r2Key, f.bytes, { httpMetadata: { contentType: f.contentType } });

      return {
        contentType: f.contentType,
        deploymentId,
        path: f.path,
        r2Key,
        sha256: await sha256Hex(f.bytes),
        size: f.bytes.byteLength,
      };
    }),
  );

  await upsertFileRows(db, rows);
};

const presignUploads = async (
  db: Db,
  signing: UrlSigning,
  { deploymentId, files, gameId }: { deploymentId: string; files: PresignedFile[]; gameId: string },
) => {
  const rows = files.map((f) => ({
    contentType: f.contentType ?? contentTypeForPath(f.path),
    deploymentId,
    path: f.path,
    r2Key: `games/${gameId}/${deploymentId}/${f.path}`,
    sha256: f.sha256,
    size: f.size,
  }));

  await upsertFileRows(db, rows);

  return await Promise.all(
    rows.map(async (row) => ({
      headers: { "content-type": row.contentType },
      path: row.path,
      url: await signUploadUrl({
        contentType: row.contentType,
        signing,
        target: { key: row.r2Key },
      }),
    })),
  );
};

const presignSourceArchive = async (
  db: Db,
  signing: UrlSigning,
  { bytes, deploymentId, gameId }: { bytes: number; deploymentId: string; gameId: string },
) => {
  const sourceKey = sourceKeyFor(gameId, deploymentId);
  await db
    .update(deployment)
    .set({ sourceBytes: bytes, sourceKey })
    .where(eq(deployment.id, deploymentId));

  return {
    headers: { "content-type": "application/gzip" },
    url: await signUploadUrl({
      contentType: "application/gzip",
      signing,
      target: { key: sourceKey },
    }),
  };
};

const assertFilesStored = async (
  db: Db,
  r2: R2Config,
  { deploymentId, gameId }: { deploymentId: string; gameId: string },
) => {
  const stored = new Map<string, number>();

  const listFrom: (cursor: string | undefined) => Promise<void> = async (cursor) => {
    const listed = await r2.bucket.list({
      cursor,
      limit: 1000,
      prefix: `games/${gameId}/${deploymentId}/`,
    });

    for (const object of listed.objects) {
      stored.set(object.key, object.size);
    }

    if (listed.truncated && listed.cursor !== undefined) {
      await listFrom(listed.cursor);
    }
  };

  await listFrom(undefined);

  const rows = await db.query.deploymentFile.findMany({ where: { deploymentId } });
  const missing = rows.filter((row) => stored.get(row.r2Key) !== row.size).map((row) => row.path);

  if (missing.length > 0) {
    const shown = missing.slice(0, 10).map((path) => `"${path}"`);
    const more = missing.length > shown.length ? ` and ${missing.length - shown.length} more` : "";
    throw new ORPCError("BAD_REQUEST", {
      message: `Not uploaded at its declared size: ${shown.join(", ")}${more}. PUT each to its URL from \`uploads\`; an expired URL is renewed by calling again with the file in \`presign\`.`,
    });
  }
};

const extractBundle = async (
  db: Db,
  r2: R2Config,
  { deploymentId, gameId }: { deploymentId: string; gameId: string },
) => {
  const bundleKey = bundleKeyFor(gameId, deploymentId);
  const object = await r2.bucket.get(bundleKey);

  if (!object) {
    return;
  }

  let { bytes, files: fileCount } = await deploymentTotals(db, deploymentId);
  const rows: FileRow[] = [];
  const seen = new Set<string>();
  await forEachBundleFile(object.body, { maxFileBytes: MAX_FILE_SIZE }, async (file) => {
    if (!fileSchema.shape.path.safeParse(file.path).success) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Bundle: "${file.path}" is not a valid path.`,
      });
    }

    if (seen.has(file.path)) {
      throw new ORPCError("BAD_REQUEST", { message: `Bundle: "${file.path}" appears twice.` });
    }

    seen.add(file.path);
    bytes += file.bytes.byteLength;
    fileCount += 1;

    if (bytes > MAX_TOTAL_SIZE || fileCount > MAX_FILE_COUNT) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Bundle: a deployment holds at most ${MAX_FILE_COUNT} files and ${MAX_TOTAL_SIZE} bytes.`,
      });
    }

    const contentType = contentTypeForPath(file.path);
    const r2Key = `games/${gameId}/${deploymentId}/${file.path}`;
    await r2.bucket.put(r2Key, file.bytes, { httpMetadata: { contentType } });
    rows.push({
      contentType,
      deploymentId,
      path: file.path,
      r2Key,
      sha256: await sha256Hex(file.bytes),
      size: file.bytes.byteLength,
    });
  });
  await upsertFileRows(db, rows);
  await r2.bucket.delete(bundleKey);
};

const assertSourceStored = async (db: Db, r2: R2Config, deploymentId: string) => {
  const staged = await db.query.deployment.findFirst({ where: { id: deploymentId } });

  if (
    staged === undefined ||
    staged.sourceKey === undefined ||
    staged.sourceKey === null ||
    staged.sourceKey === ""
  ) {
    return;
  }

  const object = await r2.bucket.head(staged.sourceKey);

  if (object?.size !== staged.sourceBytes) {
    throw new ORPCError("BAD_REQUEST", {
      message:
        "The source archive is not uploaded at its declared size. PUT it to `sourceUpload`; an expired URL is renewed by calling again with `sourceArchive`.",
    });
  }
};

const MAX_SOURCE_INPUT_BYTES = 64 * 1024 * 1024;

const writeSourceArchive = async (
  db: Db,
  r2: R2Config,
  { deploymentId, gameId }: { deploymentId: string; gameId: string },
) => {
  const rows = await db.query.deploymentFile.findMany({ where: { deploymentId } });
  const total = rows.reduce((acc, row) => acc + row.size, 0);

  if (total > MAX_SOURCE_INPUT_BYTES) {
    throw new ORPCError("BAD_REQUEST", {
      message: `A deployment over ${MAX_SOURCE_INPUT_BYTES} bytes can't be kept as source; publish without \`source\`.`,
    });
  }

  const entries = rows.map((row) => ({
    path: row.path,
    read: async () => {
      const object = await r2.bucket.get(row.r2Key);

      if (!object) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: `"${row.path}" is missing from storage.`,
        });
      }

      return new Uint8Array(await object.arrayBuffer());
    },
  }));

  const archive = await sourceArchive(entries);

  if (archive.byteLength > MAX_SOURCE_SIZE) {
    throw new ORPCError("BAD_REQUEST", {
      message: `The source archive would exceed ${MAX_SOURCE_SIZE} bytes; publish without \`source\`.`,
    });
  }

  const sourceKey = sourceKeyFor(gameId, deploymentId);
  await r2.bucket.put(sourceKey, archive, { httpMetadata: { contentType: "application/gzip" } });
  await db
    .update(deployment)
    .set({ sourceBytes: archive.byteLength, sourceKey })
    .where(eq(deployment.id, deploymentId));
};

const publishDeployment = async (
  db: Db,
  r2: R2Config,
  { deploymentId, gameId, source }: { deploymentId: string; gameId: string; source: boolean },
) => {
  const index = await db.query.deploymentFile.findFirst({
    where: { deploymentId, path: "index.html" },
  });

  if (!index) {
    throw new ORPCError("BAD_REQUEST", {
      message:
        "Deployment must contain index.html at the root before it can publish. A bundle puts it there when made from inside the build folder: `tar -czf game.tgz -C dist .`.",
    });
  }

  await assertFilesStored(db, r2, { deploymentId, gameId });
  await (source
    ? writeSourceArchive(db, r2, { deploymentId, gameId })
    : assertSourceStored(db, r2, deploymentId));
  await db.update(deployment).set({ status: "ready" }).where(eq(deployment.id, deploymentId));
  await db.update(game).set({ currentDeploymentId: deploymentId }).where(eq(game.id, gameId));

  const stale = await db
    .delete(deployment)
    .where(
      and(
        eq(deployment.gameId, gameId),
        sql`${deployment.id} <> (select ${game.currentDeploymentId} from ${game} where ${game.id} = ${gameId})`,
      ),
    )
    .returning({ id: deployment.id });

  await runInOrder(stale, async ({ id }) => {
    await deletePrefix({ prefix: `games/${gameId}/${id}/`, r2 });
    await deletePrefix({ prefix: `sources/${gameId}/${id}/`, r2 });
    await r2.bucket.delete(bundleKeyFor(gameId, id));
  });
};

const authed = os.deploy.use(requireSession);

export const deployRouter = {
  /**
   * Begin a new deployment. Validates the slug, overwrites any previous
   * deployment for this game (single-deploy MVP), and returns presigned PUT
   * URLs the client uses to upload each file directly to R2.
   */
  create: authed.create.handler(async ({ context, input }) => {
    const r2 = requireR2(context.r2);
    const signing = requireSigning(context.signing);
    const userId = context.session.user.id;

    if (isSlugReserved(input.slug)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Slug "${input.slug}" is reserved.`,
      });
    }

    const totalBytes = validateManifest(input.files);

    const existing = await claimGame(context.db, userId, { name: input.name, slug: input.slug });
    const gameId = existing.id;

    if (existing.currentDeploymentId !== null && existing.currentDeploymentId !== "") {
      await deletePrefix({ prefix: `games/${gameId}/`, r2 });
      await deletePrefix({ prefix: `sources/${gameId}/`, r2 });
      await context.db.update(game).set({ currentDeploymentId: null }).where(eq(game.id, gameId));
      await context.db.delete(deployment).where(eq(deployment.gameId, gameId));
    }

    const deploymentId = crypto.randomUUID();
    const sourceKey = input.source ? sourceKeyFor(gameId, deploymentId) : null;
    await context.db.insert(deployment).values({
      fileCount: input.files.length,
      gameId,
      id: deploymentId,
      sourceBytes: input.source?.bytes ?? null,
      sourceKey,
      status: "pending",
      totalBytes,
    });

    const fileRows = input.files.map((f) => ({
      contentType: f.contentType,
      deploymentId,
      path: f.path,
      r2Key: `games/${gameId}/${deploymentId}/${f.path}`,
      sha256: f.sha256,
      size: f.size,
    }));

    const BATCH_SIZE = 10;

    await runInOrder(batchesOf(fileRows, BATCH_SIZE), async (batch) => {
      await context.db.insert(deploymentFile).values(batch);
    });

    const uploads = await Promise.all(
      fileRows.map(async (row) => ({
        headers: { "content-type": row.contentType },
        path: row.path,
        url: await signUploadUrl({
          contentType: row.contentType,
          signing,
          target: { key: row.r2Key },
        }),
      })),
    );

    const sourceUpload =
      sourceKey !== null && sourceKey !== ""
        ? {
            headers: { "content-type": "application/gzip" },
            url: await signUploadUrl({
              contentType: "application/gzip",
              signing,
              target: { key: sourceKey },
            }),
          }
        : null;

    return {
      deploymentId,
      gameId,
      sourceUpload,
      uploads,
    };
  }),

  /**
   * Hard-delete a game: drop the game row (cascades to deployment +
   * deploymentFile) and clear its R2 prefix.
   */
  delete: authed.delete.handler(async ({ context, input }) => {
    const r2 = requireR2(context.r2);
    const userId = context.session.user.id;

    const g = await context.db.query.game.findFirst({
      where: { id: input.gameId, userId },
    });

    if (!g) {
      throw new ORPCError("NOT_FOUND");
    }

    await deletePrefix({ prefix: `games/${g.id}/`, r2 });
    await deletePrefix({ prefix: `sources/${g.id}/`, r2 });
    await deletePrefix({ prefix: `bundles/${g.id}/`, r2 });
    await context.db.delete(game).where(eq(game.id, g.id));

    return { success: true as const };
  }),

  /**
   * Mark a pending deployment as ready and flip the game's current pointer.
   * After this call, `{slug}.vibedgames.com` serves the new files.
   */
  finalize: authed.finalize.handler(async ({ context, input }) => {
    const userId = context.session.user.id;

    const dep = await context.db.query.deployment.findFirst({
      where: { id: input.deploymentId },
    });

    if (!dep) {
      throw new ORPCError("NOT_FOUND", { message: "Deployment not found." });
    }

    const g = await context.db.query.game.findFirst({
      where: { id: dep.gameId },
    });

    if (!g || g.userId !== userId) {
      throw new ORPCError("FORBIDDEN");
    }

    if (dep.status !== "pending") {
      throw new ORPCError("BAD_REQUEST", {
        message: `Deployment already ${dep.status}.`,
      });
    }

    await context.db.update(deployment).set({ status: "ready" }).where(eq(deployment.id, dep.id));

    await context.db.update(game).set({ currentDeploymentId: dep.id }).where(eq(game.id, g.id));

    return { slug: g.slug, url: publicGameUrl(context.productionURL, g.slug) };
  }),

  /**
   * Resolve a slug's current source archive to a short-lived download URL.
   * Source is forkable by default: any authenticated user may fork any
   * project that shipped source (login required, not ownership). Throws
   * NOT_FOUND if the slug has no deployment or that deployment shipped none.
   */
  getSource: authed.getSource.handler(async ({ context, input }) => {
    const signing = requireSigning(context.signing);

    const g = await context.db.query.game.findFirst({
      where: { slug: input.slug },
    });

    if (
      g === undefined ||
      g.currentDeploymentId === undefined ||
      g.currentDeploymentId === null ||
      g.currentDeploymentId === ""
    ) {
      throw new ORPCError("NOT_FOUND", {
        message: `No live deployment for "${input.slug}".`,
      });
    }

    const dep = await context.db.query.deployment.findFirst({
      where: { id: g.currentDeploymentId },
    });

    if (
      dep === undefined ||
      dep.sourceKey === undefined ||
      dep.sourceKey === null ||
      dep.sourceKey === ""
    ) {
      throw new ORPCError("NOT_FOUND", {
        message: `"${input.slug}" was deployed without source, so it can't be forked.`,
      });
    }

    return {
      bytes: dep.sourceBytes ?? null,
      name: g.name,
      slug: g.slug,
      url: await signDownloadUrl({ key: dep.sourceKey, signing }),
    };
  }),

  /**
   * List the authenticated user's games.
   */
  list: authed.list.handler(async ({ context }) => {
    const games = await context.db.query.game.findMany({
      orderBy: { updatedAt: "desc" },
      where: { userId: context.session.user.id },
    });

    const currentIds = games
      .map((g) => g.currentDeploymentId)
      .filter((id): id is string => id !== null);

    const deployments =
      currentIds.length > 0
        ? await context.db
            .select({
              createdAt: deployment.createdAt,
              fileCount: deployment.fileCount,
              id: deployment.id,
              status: deployment.status,
              totalBytes: deployment.totalBytes,
            })
            .from(deployment)
            .where(inArray(deployment.id, currentIds))
        : [];

    const byId = new Map(deployments.map((d) => [d.id, d]));

    return {
      games: games.map((g) =>
        Object.assign(g, {
          deployment:
            g.currentDeploymentId === null ? null : (byId.get(g.currentDeploymentId) ?? null),
        }),
      ),
    };
  }),

  /**
   * Deploy from files carried in the request. Unlike `create`, the live
   * deployment stays up while a new one is staged beside it (call after call),
   * and is removed only once `publish` has pointed the game at the new one.
   */
  upload: authed.upload.handler(async ({ context, input }) => {
    const r2 = requireR2(context.r2);
    const signing = requireSigning(context.signing);

    if (isSlugReserved(input.slug)) {
      throw new ORPCError("BAD_REQUEST", { message: `Slug "${input.slug}" is reserved.` });
    }

    if (input.source && input.sourceArchive) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Give `source: true` or a `sourceArchive`, not both.",
      });
    }

    const files = await decodeInlineFiles(input.files);
    assertDistinctPaths(files, input.presign);

    const { id: gameId } = await claimGame(context.db, context.session.user.id, {
      create: input.deploymentId === undefined,
      name: input.name,
      slug: input.slug,
    });

    const deploymentId = await stageDeployment(context.db, gameId, input.deploymentId);
    assertUploadBudget(await deploymentTotals(context.db, deploymentId), files, input.presign);
    await writeUploadedFiles(context.db, r2, { deploymentId, files, gameId });

    const uploads = await presignUploads(context.db, signing, {
      deploymentId,
      files: input.presign,
      gameId,
    });

    const sourceUpload = input.sourceArchive
      ? await presignSourceArchive(context.db, signing, {
          bytes: input.sourceArchive.bytes,
          deploymentId,
          gameId,
        })
      : null;

    const bundleUpload = input.bundle
      ? {
          headers: { "content-type": "application/gzip" },
          url: await signUploadUrl({
            contentType: "application/gzip",
            signing,
            target: { key: bundleKeyFor(gameId, deploymentId) },
          }),
        }
      : null;

    if (input.publish) {
      await extractBundle(context.db, r2, { deploymentId, gameId });
    }

    const totals = await deploymentTotals(context.db, deploymentId);
    await context.db
      .update(deployment)
      .set({ fileCount: totals.files, totalBytes: totals.bytes })
      .where(eq(deployment.id, deploymentId));

    const summary = {
      bundleUpload,
      deploymentId,
      fileCount: totals.files,
      gameId,
      sourceUpload,
      totalBytes: totals.bytes,
      uploads,
    };

    if (!input.publish) {
      return { ...summary, published: false, url: null };
    }

    await publishDeployment(context.db, r2, { deploymentId, gameId, source: input.source });

    return { ...summary, published: true, url: publicGameUrl(context.productionURL, input.slug) };
  }),
};

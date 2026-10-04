import { eq, inArray } from "@repo/db";
import { deployment, deploymentFile, game } from "@repo/db/drizzle-schema";
import type { fileSchema } from "@repo/contract/deploy/deploy-schema";
import { MAX_TOTAL_SIZE } from "@repo/contract/deploy/deploy-schema";
import { ORPCError } from "@orpc/server";
import type { z } from "zod";

import type { R2Config } from "../orpc";
import { os, requireSession } from "../orpc";
import { deletePrefix, presignGet, presignPut } from "./r2-presign";
import { isSlugReserved } from "./reserved-slugs";

/** R2 key for a deployment's forkable source archive. Lives OUTSIDE the
 *  `games/` prefix so the public games worker never serves it. */
const sourceKeyFor = (gameId: string, deploymentId: string): string =>
  `sources/${gameId}/${deploymentId}/source.tgz`;

// ---- Helpers -----------------------------------------------------------------

const requireR2 = (r2: R2Config | undefined): R2Config => {
  if (!r2) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "R2 is not configured on this worker.",
    });
  }
  return r2;
};

/** Rejects a manifest with no root index.html, over budget, or duplicate paths; returns its total byte size. */
const validateManifest = (files: z.infer<typeof fileSchema>[]): number => {
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

const authed = os.deploy.use(requireSession);

export const deployRouter = {
  /**
   * Begin a new deployment. Validates the slug, overwrites any previous
   * deployment for this game (single-deploy MVP), and returns presigned PUT
   * URLs the client uses to upload each file directly to R2.
   */
  create: authed.create.handler(async ({ context, input }) => {
    const r2 = requireR2(context.r2);
    const userId = context.session.user.id;

    // ---- Validate slug ------------------------------------------------------
    if (isSlugReserved(input.slug)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Slug "${input.slug}" is reserved.`,
      });
    }

    const totalBytes = validateManifest(input.files);

    // ---- Resolve or create game row ----------------------------------------
    const existing = await context.db.query.game.findFirst({
      where: { slug: input.slug },
    });

    if (existing && existing.userId !== userId) {
      throw new ORPCError("FORBIDDEN", {
        message: `Slug "${input.slug}" is already taken.`,
      });
    }

    const gameId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      await context.db.insert(game).values({
        id: gameId,
        name: input.name ?? null,
        slug: input.slug,
        userId,
      });
    } else if (input.name && input.name !== existing.name) {
      await context.db.update(game).set({ name: input.name }).where(eq(game.id, gameId));
    }

    // ---- Wipe previous deployment (single-deploy MVP) ----------------------
    // Clear R2 first, then DB rows. Cascade on deployment → deploymentFile
    // takes care of the file metadata. We null out currentDeploymentId so
    // the FK to a row we're about to delete is valid.
    if (existing?.currentDeploymentId) {
      await deletePrefix({ prefix: `games/${gameId}/`, r2 });
      await deletePrefix({ prefix: `sources/${gameId}/`, r2 });
      await context.db.update(game).set({ currentDeploymentId: null }).where(eq(game.id, gameId));
      await context.db.delete(deployment).where(eq(deployment.gameId, gameId));
    }

    // ---- Create pending deployment -----------------------------------------
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
    // D1 has a max SQL statement size — batch inserts in chunks
    const BATCH_SIZE = 10;
    for (let i = 0; i < fileRows.length; i += BATCH_SIZE) {
      await context.db.insert(deploymentFile).values(fileRows.slice(i, i + BATCH_SIZE));
    }

    // ---- Mint presigned URLs -----------------------------------------------
    const uploads = await Promise.all(
      fileRows.map(async (row) => ({
        headers: { "content-type": row.contentType },
        path: row.path,
        url: await presignPut({
          contentType: row.contentType,
          key: row.r2Key,
          r2,
        }),
      })),
    );

    // ---- Mint source-archive presigned PUT (forkable source) ----------------
    const sourceUpload = sourceKey
      ? {
          headers: { "content-type": "application/gzip" },
          url: await presignPut({ contentType: "application/gzip", key: sourceKey, r2 }),
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

    const base = new URL(context.productionURL ?? "https://vibedgames.com");
    return {
      slug: g.slug,
      url: `${base.protocol}//${g.slug}.${base.host}`,
    };
  }),

  /**
   * Resolve a slug's current source archive to a short-lived download URL.
   * Source is forkable by default: any authenticated user may fork any
   * project that shipped source (login required, not ownership). Throws
   * NOT_FOUND if the slug has no deployment or that deployment shipped none.
   */
  getSource: authed.getSource.handler(async ({ context, input }) => {
    const r2 = requireR2(context.r2);

    const g = await context.db.query.game.findFirst({
      where: { slug: input.slug },
    });
    if (!g?.currentDeploymentId) {
      throw new ORPCError("NOT_FOUND", {
        message: `No live deployment for "${input.slug}".`,
      });
    }

    const dep = await context.db.query.deployment.findFirst({
      where: { id: g.currentDeploymentId },
    });
    if (!dep?.sourceKey) {
      throw new ORPCError("NOT_FOUND", {
        message: `"${input.slug}" was deployed without source, so it can't be forked.`,
      });
    }

    return {
      bytes: dep.sourceBytes ?? null,
      name: g.name,
      slug: g.slug,
      url: await presignGet({ expiresInSeconds: 3600, key: dep.sourceKey, r2 }),
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

    // Surface each game's live deployment (status/size/date) for the games
    // dashboard. One IN query over the pinned deployment ids — games with no
    // deployment yet (or mid-first-deploy) get `deployment: null`.
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
};

import { and, eq } from "@repo/db";
import { deployment, deploymentFile, game } from "@repo/db/drizzle-schema";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { R2Config } from "../trpc";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { deletePrefix, presignPut } from "./r2-presign";
import { isSlugReserved } from "./reserved-slugs";

// ---- Limits ------------------------------------------------------------------

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50 MB per deploy
const MAX_FILE_COUNT = 500;

// ---- Schemas -----------------------------------------------------------------

const slugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message: "slug must be lowercase alphanumeric with hyphens",
  });

const fileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .refine((p) => !p.startsWith("/"), "path must be relative")
    .refine((p) => !p.includes(".."), "path must not contain .."),
  size: z.number().int().nonnegative().max(MAX_FILE_SIZE),
  sha256: z.string().length(64),
  contentType: z.string().min(1).max(127),
});

const createInput = z.object({
  slug: slugSchema,
  name: z.string().max(120).optional(),
  files: z.array(fileSchema).min(1).max(MAX_FILE_COUNT),
});

const finalizeInput = z.object({
  deploymentId: z.string(),
});

const deleteInput = z.object({
  gameId: z.string(),
});

// ---- Helpers -----------------------------------------------------------------

function requireR2(r2: R2Config | undefined): R2Config {
  if (!r2) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "R2 is not configured on this worker.",
    });
  }
  return r2;
}

function buildGameUrl(productionURL: string | undefined, slug: string): string {
  // e.g. https://vibedgames.com → https://pong.vibedgames.com
  const base = productionURL ?? "https://vibedgames.com";
  const u = new URL(base);
  return `${u.protocol}//${slug}.${u.host}`;
}

// ---- Router ------------------------------------------------------------------

export const deployRouter = createTRPCRouter({
  /**
   * Begin a new deployment. Validates the slug, overwrites any previous
   * deployment for this game (single-deploy MVP), and returns presigned PUT
   * URLs the client uses to upload each file directly to R2.
   */
  create: protectedProcedure
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
      const r2 = requireR2(ctx.r2);
      const userId = ctx.session.user.id;

      // ---- Validate slug ------------------------------------------------------
      if (isSlugReserved(input.slug)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Slug "${input.slug}" is reserved.`,
        });
      }

      // ---- Validate manifest --------------------------------------------------
      const hasIndex = input.files.some((f) => f.path === "index.html");
      if (!hasIndex) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Deployment must contain index.html at the root.",
        });
      }

      const totalBytes = input.files.reduce((acc, f) => acc + f.size, 0);
      if (totalBytes > MAX_TOTAL_SIZE) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Total deploy size ${totalBytes} exceeds limit ${MAX_TOTAL_SIZE}.`,
        });
      }

      // dedupe paths
      const paths = new Set<string>();
      for (const f of input.files) {
        if (paths.has(f.path)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Duplicate path "${f.path}" in manifest.`,
          });
        }
        paths.add(f.path);
      }

      // ---- Resolve or create game row ----------------------------------------
      const existing = await ctx.db.query.game.findFirst({
        where: eq(game.slug, input.slug),
      });

      if (existing && existing.userId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Slug "${input.slug}" is already taken.`,
        });
      }

      const gameId = existing?.id ?? crypto.randomUUID();
      if (!existing) {
        await ctx.db.insert(game).values({
          id: gameId,
          userId,
          slug: input.slug,
          name: input.name ?? null,
        });
      } else if (input.name && input.name !== existing.name) {
        await ctx.db
          .update(game)
          .set({ name: input.name })
          .where(eq(game.id, gameId));
      }

      // ---- Wipe previous deployment (single-deploy MVP) ----------------------
      // Clear R2 first, then DB rows. Cascade on deployment → deploymentFile
      // takes care of the file metadata. We null out currentDeploymentId so
      // the FK to a row we're about to delete is valid.
      if (existing?.currentDeploymentId) {
        await deletePrefix({ r2, prefix: `games/${gameId}/` });
        await ctx.db
          .update(game)
          .set({ currentDeploymentId: null })
          .where(eq(game.id, gameId));
        await ctx.db
          .delete(deployment)
          .where(eq(deployment.gameId, gameId));
      }

      // ---- Create pending deployment -----------------------------------------
      const deploymentId = crypto.randomUUID();
      await ctx.db.insert(deployment).values({
        id: deploymentId,
        gameId,
        status: "pending",
        fileCount: input.files.length,
        totalBytes,
      });

      const fileRows = input.files.map((f) => ({
        deploymentId,
        path: f.path,
        contentType: f.contentType,
        size: f.size,
        sha256: f.sha256,
        r2Key: `games/${gameId}/${deploymentId}/${f.path}`,
      }));
      await ctx.db.insert(deploymentFile).values(fileRows);

      // ---- Mint presigned URLs -----------------------------------------------
      const uploads = await Promise.all(
        fileRows.map(async (row) => ({
          path: row.path,
          url: await presignPut({
            r2,
            key: row.r2Key,
            contentType: row.contentType,
          }),
          headers: { "content-type": row.contentType },
        })),
      );

      return {
        deploymentId,
        gameId,
        uploads,
      };
    }),

  /**
   * Mark a pending deployment as ready and flip the game's current pointer.
   * After this call, `{slug}.vibedgames.com` serves the new files.
   */
  finalize: protectedProcedure
    .input(finalizeInput)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const dep = await ctx.db.query.deployment.findFirst({
        where: eq(deployment.id, input.deploymentId),
      });
      if (!dep) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Deployment not found." });
      }

      const g = await ctx.db.query.game.findFirst({
        where: eq(game.id, dep.gameId),
      });
      if (!g || g.userId !== userId) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      if (dep.status !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Deployment already ${dep.status}.`,
        });
      }

      await ctx.db
        .update(deployment)
        .set({ status: "ready" })
        .where(eq(deployment.id, dep.id));

      await ctx.db
        .update(game)
        .set({ currentDeploymentId: dep.id })
        .where(eq(game.id, g.id));

      return {
        url: buildGameUrl(ctx.productionURL, g.slug),
        slug: g.slug,
      };
    }),

  /**
   * List the authenticated user's games.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const games = await ctx.db.query.game.findMany({
      where: eq(game.userId, ctx.session.user.id),
      orderBy: (g, { desc }) => desc(g.updatedAt),
    });
    return { games };
  }),

  /**
   * Hard-delete a game: drop the game row (cascades to deployment +
   * deploymentFile) and clear its R2 prefix.
   */
  delete: protectedProcedure
    .input(deleteInput)
    .mutation(async ({ ctx, input }) => {
      const r2 = requireR2(ctx.r2);
      const userId = ctx.session.user.id;

      const g = await ctx.db.query.game.findFirst({
        where: and(eq(game.id, input.gameId), eq(game.userId, userId)),
      });
      if (!g) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      await deletePrefix({ r2, prefix: `games/${g.id}/` });
      await ctx.db.delete(game).where(eq(game.id, g.id));

      return { success: true };
    }),
});

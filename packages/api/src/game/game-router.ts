import { eq } from "@repo/db";
import { gameBuild } from "@repo/db/drizzle-schema";
import { TRPCError } from "@trpc/server";

import { persistFiles } from "../agent/tools/game-persistence";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  createBuildInput,
  deleteBuildInput,
  getBuildInput,
  listBuildsInput,
  updateBuildFilesInput,
  updateBuildInput,
} from "./game-schema";

const DEFAULT_BUILD_LIMIT = 20;

type GameBuildRow = typeof gameBuild.$inferSelect;

function assertBuildAccess({
  build,
  userId,
}: {
  build: GameBuildRow;
  userId: string;
}) {
  if (build.userId === userId) return;

  throw new TRPCError({ code: "UNAUTHORIZED", message: "Access denied." });
}

export const gameRouter = createTRPCRouter({
  listBuilds: protectedProcedure
    .input(listBuildsInput)
    .query(async ({ ctx, input }) => {
      const limit = input.limit ?? DEFAULT_BUILD_LIMIT;

      const builds = await ctx.db.query.gameBuild.findMany({
        where: (builds, { eq, and, lt }) =>
          input.cursor
            ? and(
                eq(builds.userId, ctx.session.user.id),
                lt(builds.id, input.cursor),
              )
            : eq(builds.userId, ctx.session.user.id),
        orderBy: (builds, { desc }) => desc(builds.createdAt),
        limit: limit + 1,
        with: {
          gameBuildFiles: true,
        },
      });

      const hasNextPage = builds.length > limit;
      const items = hasNextPage ? builds.slice(0, limit) : builds;
      const nextCursor = hasNextPage ? items[items.length - 1]?.id : undefined;

      return {
        builds: items,
        nextCursor,
      };
    }),

  getBuild: protectedProcedure
    .input(getBuildInput)
    .query(async ({ ctx, input }) => {
      const build =
        (await ctx.db.query.gameBuild.findFirst({
          where: (builds, { eq }) => eq(builds.id, input.buildId),
          with: {
            gameBuildFiles: true,
          },
        })) ?? null;

      if (!build) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Build not found.",
        });
      }

      assertBuildAccess({
        build,
        userId: ctx.session.user.id,
      });

      return {
        build,
      };
    }),

  createBuild: protectedProcedure
    .input(createBuildInput)
    .mutation(async ({ ctx, input }) => {
      const buildId = crypto.randomUUID();

      await ctx.db.insert(gameBuild).values({
        id: buildId,
        userId: ctx.session.user.id,
        organizationId: input.organizationId ?? null,
        title: input.title ?? null,
        description: input.description ?? null,
        previewUrl:
          input.previewUrl && input.previewUrl !== "" ? input.previewUrl : null,
      });

      // Persist files if provided
      if (input.files.length > 0) {
        await persistFiles({
          db: ctx.db,
          buildId,
          files: input.files,
        });
      }

      // Fetch the complete build with files
      const build = await ctx.db.query.gameBuild.findFirst({
        where: (builds, { eq }) => eq(builds.id, buildId),
        with: {
          gameBuildFiles: true,
        },
      });

      if (!build) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create build.",
        });
      }

      return {
        build,
      };
    }),

  updateBuildFiles: protectedProcedure
    .input(updateBuildFilesInput)
    .mutation(async ({ ctx, input }) => {
      const build = await ctx.db.query.gameBuild.findFirst({
        where: (builds, { eq }) => eq(builds.id, input.buildId),
      });

      if (!build) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Build not found.",
        });
      }

      assertBuildAccess({
        build,
        userId: ctx.session.user.id,
      });

      await persistFiles({
        db: ctx.db,
        buildId: input.buildId,
        files: input.files,
      });

      // Fetch the updated build with files
      const updatedBuild = await ctx.db.query.gameBuild.findFirst({
        where: (builds, { eq }) => eq(builds.id, input.buildId),
        with: {
          gameBuildFiles: true,
        },
      });

      if (!updatedBuild) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update build.",
        });
      }

      return {
        build: updatedBuild,
      };
    }),

  updateBuild: protectedProcedure
    .input(updateBuildInput)
    .mutation(async ({ ctx, input }) => {
      const build = await ctx.db.query.gameBuild.findFirst({
        where: (builds, { eq }) => eq(builds.id, input.buildId),
      });

      if (!build) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Build not found.",
        });
      }

      assertBuildAccess({
        build,
        userId: ctx.session.user.id,
      });

      await ctx.db
        .update(gameBuild)
        .set({
          title: input.title ?? build.title,
          description: input.description ?? build.description,
          previewUrl:
            input.previewUrl !== undefined
              ? input.previewUrl && input.previewUrl !== ""
                ? input.previewUrl
                : null
              : build.previewUrl,
        })
        .where(eq(gameBuild.id, input.buildId));

      // Fetch the updated build
      const updatedBuild = await ctx.db.query.gameBuild.findFirst({
        where: (builds, { eq }) => eq(builds.id, input.buildId),
        with: {
          gameBuildFiles: true,
        },
      });

      if (!updatedBuild) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update build.",
        });
      }

      return {
        build: updatedBuild,
      };
    }),

  deleteBuild: protectedProcedure
    .input(deleteBuildInput)
    .mutation(async ({ ctx, input }) => {
      const build = await ctx.db.query.gameBuild.findFirst({
        where: (builds, { eq }) => eq(builds.id, input.buildId),
      });

      if (!build) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Build not found.",
        });
      }

      assertBuildAccess({
        build,
        userId: ctx.session.user.id,
      });

      await ctx.db.delete(gameBuild).where(eq(gameBuild.id, input.buildId));

      return {
        success: true,
      };
    }),
});

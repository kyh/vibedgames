import { TRPCError } from "@trpc/server";

import type { gameBuild } from "@repo/db/drizzle-schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { getBuildInput, listBuildsInput } from "./game-schema";

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
});

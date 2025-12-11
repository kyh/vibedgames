import { and, eq, lt } from "@repo/db";
import { gameProject } from "@repo/db/drizzle-schema";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  getBuildSnapshotInput,
  getProjectInput,
  listBuildsInput,
} from "./game-schema";

const DEFAULT_BUILD_LIMIT = 20;

type GameProjectRow = typeof gameProject.$inferSelect;

function assertProjectAccess({
  project,
  userId,
}: {
  project: GameProjectRow;
  userId: string;
}) {
  if (project.userId === userId) return;

  throw new TRPCError({ code: "UNAUTHORIZED", message: "Access denied." });
}

export const gameRouter = createTRPCRouter({
  getProject: protectedProcedure
    .input(getProjectInput)
    .query(async ({ ctx, input }) => {
      const project =
        (await ctx.db.query.gameProject.findFirst({
          where: (projects, { eq }) => eq(projects.id, input.projectId),
        })) ?? null;

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found.",
        });
      }

      assertProjectAccess({
        project,
        userId: ctx.session.user.id,
      });

      const latestBuild = await ctx.db.query.gameBuild.findFirst({
        where: (builds, { eq }) => eq(builds.projectId, project.id),
        orderBy: (builds, { desc }) => desc(builds.buildNumber),
      });

      return {
        project,
        latestBuild,
      };
    }),

  listBuilds: protectedProcedure
    .input(listBuildsInput)
    .query(async ({ ctx, input }) => {
      const project =
        (await ctx.db.query.gameProject.findFirst({
          where: (projects, { eq }) => eq(projects.id, input.projectId),
        })) ?? null;

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found.",
        });
      }

      assertProjectAccess({
        project,
        userId: ctx.session.user.id,
      });

      const limit = input.limit ?? DEFAULT_BUILD_LIMIT;

      const builds = await ctx.db.query.gameBuild.findMany({
        where: (builds) =>
          input.cursor
            ? and(
                eq(builds.projectId, project.id),
                lt(builds.buildNumber, input.cursor),
              )
            : eq(builds.projectId, project.id),
        orderBy: (builds, { desc }) => desc(builds.buildNumber),
        limit: limit + 1,
      });

      const hasNextPage = builds.length > limit;
      const items = hasNextPage ? builds.slice(0, limit) : builds;
      const nextCursor = hasNextPage
        ? items[items.length - 1]?.buildNumber
        : undefined;

      return {
        builds: items,
        nextCursor,
      };
    }),

  getBuildSnapshot: protectedProcedure
    .input(getBuildSnapshotInput)
    .query(async ({ ctx, input }) => {
      const project =
        (await ctx.db.query.gameProject.findFirst({
          where: (projects, { eq }) => eq(projects.id, input.projectId),
        })) ?? null;

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found.",
        });
      }

      assertProjectAccess({
        project,
        userId: ctx.session.user.id,
      });

      const build =
        (await ctx.db.query.gameBuild.findFirst({
          where: (builds, { and, eq }) =>
            and(
              eq(builds.projectId, project.id),
              eq(builds.buildNumber, input.buildNumber),
            ),
          with: {
            files: true,
          },
        })) ?? null;

      if (!build) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Build not found.",
        });
      }

      return {
        build,
        project,
        files: build.files,
      };
    }),
});

import { and, eq, sql } from "@repo/db";
import { gameBuild, gameBuildFile, gameProject } from "@repo/db/drizzle-schema";

import type { Db } from "@repo/db/drizzle-client";

type PersistFilesParams = {
  db: Db;
  projectId: string;
  buildNumber: number;
  files: {
    path: string;
    content: string;
  }[];
};

export async function getBuildByProjectAndNumber(
  db: Db,
  projectId: string,
  buildNumber: number,
) {
  return (
    (await db.query.gameBuild.findFirst({
      where: (builds, { and, eq }) =>
        and(
          eq(builds.projectId, projectId),
          eq(builds.buildNumber, buildNumber),
        ),
    })) ?? null
  );
}

export async function persistFiles({
  db,
  projectId,
  buildNumber,
  files,
}: PersistFilesParams) {
  if (!files.length) return;

  const now = new Date();
  const values = files.map((file) => ({
    projectId,
    buildNumber,
    path: file.path,
    content: file.content,
    recordedAt: now,
  }));

  await db
    .insert(gameBuildFile)
    .values(values)
    .onConflictDoUpdate({
      target: [
        gameBuildFile.projectId,
        gameBuildFile.buildNumber,
        gameBuildFile.path,
      ],
      set: {
        content: sql`excluded.content`,
        recordedAt: sql`excluded.recorded_at`,
      },
    });

  await db
    .update(gameBuild)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(gameBuild.projectId, projectId),
        eq(gameBuild.buildNumber, buildNumber),
      ),
    );

  await db
    .update(gameProject)
    .set({ updatedAt: new Date() })
    .where(eq(gameProject.id, projectId));
}

export async function getNextBuildNumber(db: Db, projectId: string) {
  const latest = await db.query.gameBuild.findFirst({
    where: (builds, { eq }) => eq(builds.projectId, projectId),
    orderBy: (builds, { desc }) => desc(builds.buildNumber),
  });
  return (latest?.buildNumber ?? 0) + 1;
}

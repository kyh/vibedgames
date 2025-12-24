import { eq, sql } from "@repo/db";
import { gameBuild, gameBuildFile } from "@repo/db/drizzle-schema";

import type { Db } from "@repo/db/drizzle-client";

type PersistFilesParams = {
  db: Db;
  buildId: string;
  files: {
    path: string;
    content: string;
  }[];
};

export async function getBuildById(db: Db, buildId: string) {
  return (
    (await db.query.gameBuild.findFirst({
      where: (builds, { eq }) => eq(builds.id, buildId),
    })) ?? null
  );
}

export async function persistFiles({ db, buildId, files }: PersistFilesParams) {
  if (!files.length) return;

  const now = new Date();
  const values = files.map((file) => ({
    buildId,
    path: file.path,
    content: file.content,
    createdAt: now,
    updatedAt: now,
  }));

  await db
    .insert(gameBuildFile)
    .values(values)
    .onConflictDoUpdate({
      target: [gameBuildFile.buildId, gameBuildFile.path],
      set: {
        content: sql`excluded.content`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  await db
    .update(gameBuild)
    .set({ updatedAt: new Date() })
    .where(eq(gameBuild.id, buildId));
}

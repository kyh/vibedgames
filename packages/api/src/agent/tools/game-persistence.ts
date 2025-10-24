import { randomUUID } from "crypto";
import type { ModelMessage } from "ai";
import { and, eq, sql } from "@repo/db";
import { gameBuild, gameBuildFile, gameProject } from "@repo/db/drizzle-schema";

import type { Session } from "@repo/api/auth/auth";
import type { Db } from "@repo/db/drizzle-client";

type EnsureBuildParams = {
  db: Db;
  session: Session | null;
  sandboxId: string;
  modelId: string;
  messages: ModelMessage[];
  projectId?: string;
  buildNumber?: number;
};

type PersistFilesParams = {
  db: Db;
  projectId: string;
  buildNumber: number;
  files: {
    path: string;
    content: string;
  }[];
};

export async function ensureProjectAndBuild({
  db,
  session,
  sandboxId,
  modelId,
  messages,
  projectId,
  buildNumber,
}: EnsureBuildParams) {
  if (!session?.user.id) {
    throw new Error("Unable to create build: missing authenticated user.");
  }

  const initialPrompt = extractInitialPrompt(messages);
  const normalizedTitle =
    initialPrompt?.split("\n").at(0)?.trim().slice(0, 120) ??
    "Untitled Project";
  let project =
    projectId !== undefined
      ? await db.query.gameProject.findFirst({
          where: (projects, { eq }) => eq(projects.id, projectId),
        })
      : null;

  if (projectId) {
    if (!project) {
      throw new Error("Unable to load project: project not found.");
    }

    if (project.userId !== session.user.id) {
      throw new Error("Unable to load project: access denied.");
    }
  }

  if (!project) {
    const [inserted] = await db
      .insert(gameProject)
      .values({
        id: randomUUID(),
        userId: session.user.id,
        title: normalizedTitle,
        description: initialPrompt ?? null,
      })
      .returning();
    project = inserted;
  }

  let build: Awaited<ReturnType<typeof db.query.gameBuild.findFirst>> | null =
    null;

  if (projectId && buildNumber !== undefined) {
    if (!project) {
      throw new Error("Project not found when trying to get build.");
    }
    build = await getBuildByProjectAndNumber(db, project.id, buildNumber);

    if (!build) {
      throw new Error("Unable to load build: build not found.");
    }

    const currentBuildNumber = build.buildNumber;

    await db
      .update(gameBuild)
      .set({
        sandboxId,
        modelId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gameBuild.projectId, project.id),
          eq(gameBuild.buildNumber, currentBuildNumber),
        ),
      );

    const updatedBuild = await db.query.gameBuild.findFirst({
      where: (builds, { and, eq }) =>
        and(
          eq(builds.projectId, project.id),
          eq(builds.buildNumber, currentBuildNumber),
        ),
    });

    build = updatedBuild ?? build;
  }

  if (!build) {
    if (!project) {
      throw new Error("Project not found when creating new build.");
    }
    const nextBuildNumber = await getNextBuildNumber(db, project.id);

    const [insertedBuild] = await db
      .insert(gameBuild)
      .values({
        projectId: project.id,
        buildNumber: nextBuildNumber,
        createdById: session.user.id,
        sandboxId,
        modelId,
      })
      .returning();

    build = insertedBuild;
  }

  if (project) {
    await db
      .update(gameProject)
      .set({ updatedAt: new Date() })
      .where(eq(gameProject.id, project.id));
  }

  return { project, build };
}

export async function getBuildBySandbox(db: Db, sandboxId: string) {
  if (!sandboxId) return null;
  return (
    (await db.query.gameBuild.findFirst({
      where: (builds, { eq }) => eq(builds.sandboxId, sandboxId),
    })) ?? null
  );
}

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

function extractInitialPrompt(messages: ModelMessage[]) {
  for (const message of messages) {
    if (message.role !== "user") continue;

    if (typeof message.content === "string") {
      if (message.content.trim()) {
        return message.content.trim();
      }
    } else if (Array.isArray(message.content)) {
      const textContent = message.content
        .map((part) => {
          if (
            typeof part === "object" &&
            "type" in part &&
            part.type === "text"
          ) {
            return (part as { text?: string }).text ?? "";
          }
          return "";
        })
        .join(" ")
        .trim();
      if (textContent) {
        return textContent;
      }
    }
  }
  return undefined;
}

export async function getNextBuildNumber(db: Db, projectId: string) {
  const latest = await db.query.gameBuild.findFirst({
    where: (builds, { eq }) => eq(builds.projectId, projectId),
    orderBy: (builds, { desc }) => desc(builds.buildNumber),
  });
  return (latest?.buildNumber ?? 0) + 1;
}

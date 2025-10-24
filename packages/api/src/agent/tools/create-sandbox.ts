import { Buffer } from "node:buffer";
import type { ModelMessage, UIMessage, UIMessageStreamWriter } from "ai";
import { Sandbox } from "@vercel/sandbox";
import { tool } from "ai";
import z from "zod";

import type { DataPart } from "../messages/data-parts";
import type { Session } from "@repo/api/auth/auth";
import type { Db } from "@repo/db/drizzle-client";
import description from "./create-sandbox.md";
import {
  ensureProjectAndBuild,
  getBuildByProjectAndNumber,
} from "./game-persistence";
import { getRichError } from "./get-rich-error";

type Params = {
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  db: Db;
  session: Session | null;
  modelId: string;
  projectId?: string;
  buildNumber?: number;
};

type ProjectValidationResult = {
  projectId: string;
  project: NonNullable<
    Awaited<ReturnType<Db["query"]["gameProject"]["findFirst"]>>
  >;
};

type BuildRetrievalResult = {
  buildRecord: Awaited<ReturnType<typeof getBuildByProjectAndNumber>> | null;
  buildNumber: number | undefined;
};

type SandboxCreationResult = {
  sandbox: Sandbox;
  sandboxWasReused: boolean;
};

/**
 * Validates project access and retrieves project information
 */
async function validateProjectAccess(
  db: Db,
  session: Session | null,
  projectId: string,
): Promise<ProjectValidationResult> {
  if (!session?.user.id) {
    throw new Error("Unable to access project: missing authenticated user.");
  }

  const project = await db.query.gameProject.findFirst({
    where: (projects, { eq }) => eq(projects.id, projectId),
  });

  if (!project) {
    throw new Error("Project not found.");
  }

  if (project.userId !== session.user.id) {
    throw new Error("Unable to access project: access denied.");
  }

  return {
    projectId: project.id,
    project,
  };
}

/**
 * Retrieves build record for a project
 */
async function getBuildRecord(
  db: Db,
  projectId: string,
  initialBuildNumber?: number,
): Promise<BuildRetrievalResult> {
  let buildRecord: Awaited<
    ReturnType<typeof getBuildByProjectAndNumber>
  > | null = null;

  if (initialBuildNumber !== undefined) {
    buildRecord = await getBuildByProjectAndNumber(
      db,
      projectId,
      initialBuildNumber,
    );
  }

  buildRecord ??=
    (await db.query.gameBuild.findFirst({
      where: (builds, { eq }) => eq(builds.projectId, projectId),
      orderBy: (builds, { desc }) => desc(builds.buildNumber),
    })) ?? null;

  return {
    buildRecord,
    buildNumber: buildRecord?.buildNumber,
  };
}

/**
 * Creates or reuses a sandbox for a project
 */
async function createOrReuseSandbox(
  buildRecord: Awaited<ReturnType<typeof getBuildByProjectAndNumber>> | null,
): Promise<SandboxCreationResult> {
  let sandbox: Sandbox | null = null;
  let sandboxWasReused = false;

  if (buildRecord?.sandboxId) {
    try {
      sandbox = await Sandbox.get({ sandboxId: buildRecord.sandboxId });
      sandboxWasReused = true;
    } catch (error) {
      console.warn(
        `Sandbox ${buildRecord.sandboxId} is unavailable, creating a new one.`,
        error,
      );
      sandbox = null;
      sandboxWasReused = false;
    }
  }

  sandbox ??= await Sandbox.create({
    timeout: 600000,
    ports: [3000],
    runtime: "node22",
  });

  return {
    sandbox,
    sandboxWasReused,
  };
}

/**
 * Restores files to a sandbox from build record
 */
async function restoreFilesToSandbox(
  sandbox: Sandbox,
  db: Db,
  buildRecord: Awaited<ReturnType<typeof getBuildByProjectAndNumber>> | null,
): Promise<void> {
  if (!buildRecord) return;

  const files = await db.query.gameBuildFile.findMany({
    where: (files, { and, eq }) =>
      and(
        eq(files.projectId, buildRecord.projectId),
        eq(files.buildNumber, buildRecord.buildNumber),
      ),
  });

  if (files.length > 0) {
    await sandbox.writeFiles(
      files.map((file) => ({
        path: file.path,
        content: Buffer.from(file.content, "utf8"),
      })),
    );
  }
}

/**
 * Handles project persistence and returns updated project/build info
 */
async function handleProjectPersistence(
  db: Db,
  session: Session | null,
  sandbox: Sandbox,
  modelId: string,
  messages: ModelMessage[],
  projectId?: string,
  buildRecord?: Awaited<ReturnType<typeof getBuildByProjectAndNumber>> | null,
): Promise<{ projectId?: string; buildNumber?: number }> {
  try {
    const { project, build } = await ensureProjectAndBuild({
      db,
      session,
      sandboxId: sandbox.sandboxId,
      modelId,
      messages,
      projectId,
      buildNumber: buildRecord ? buildRecord.buildNumber : undefined,
    });

    return {
      projectId: project?.id,
      buildNumber: build?.buildNumber,
    };
  } catch (persistenceError) {
    console.error("Failed to persist game build metadata:", persistenceError);
    return {};
  }
}

/**
 * Creates a new sandbox without project context
 */
async function createNewSandbox(): Promise<Sandbox> {
  return await Sandbox.create({
    timeout: 600000,
    ports: [3000],
    runtime: "node22",
  });
}

export const createSandbox = ({
  writer,
  db,
  session,
  modelId,
  projectId: initialProjectId,
  buildNumber: initialBuildNumber,
}: Params) =>
  tool({
    description,
    inputSchema: z.object({}),
    execute: async (_, { toolCallId, messages }) => {
      writer.write({
        id: toolCallId,
        type: "data-create-sandbox",
        data: { status: "loading" },
      });

      try {
        let projectId: string | undefined;
        let buildNumber: number | undefined;
        let buildRecord: Awaited<
          ReturnType<typeof getBuildByProjectAndNumber>
        > | null = null;
        let sandbox: Sandbox;
        let sandboxWasReused = false;

        if (initialProjectId) {
          // Validate project access
          const { projectId: validatedProjectId } = await validateProjectAccess(
            db,
            session,
            initialProjectId,
          );
          projectId = validatedProjectId;

          // Get build record
          const buildInfo = await getBuildRecord(
            db,
            projectId,
            initialBuildNumber,
          );
          buildRecord = buildInfo.buildRecord;
          buildNumber = buildInfo.buildNumber;

          // Create or reuse sandbox
          const { sandbox: createdSandbox, sandboxWasReused: wasReused } =
            await createOrReuseSandbox(buildRecord);
          sandbox = createdSandbox;
          sandboxWasReused = wasReused;

          // Restore files if needed
          await restoreFilesToSandbox(sandbox, db, buildRecord);
        } else {
          // Create new sandbox without project context
          sandbox = await createNewSandbox();
        }

        // Handle project persistence
        const persistenceResult = await handleProjectPersistence(
          db,
          session,
          sandbox,
          modelId,
          messages,
          projectId,
          buildRecord,
        );

        // Update project/build info from persistence result
        if (persistenceResult.projectId) {
          projectId = persistenceResult.projectId;
        }
        if (persistenceResult.buildNumber) {
          buildNumber = persistenceResult.buildNumber;
        }

        writer.write({
          id: toolCallId,
          type: "data-create-sandbox",
          data: {
            sandboxId: sandbox.sandboxId,
            projectId,
            buildNumber,
            status: "done",
          },
        });

        return (
          (sandboxWasReused
            ? `Reusing sandbox with ID: ${sandbox.sandboxId}.`
            : `Sandbox ready with ID: ${sandbox.sandboxId}.`) +
          (buildNumber !== undefined
            ? ` Build metadata stored as build #${buildNumber}.`
            : ` Build metadata was not stored; check server logs.`) +
          `\nYou can now upload files, run commands, and access services on the exposed ports.`
        );
      } catch (error) {
        const richError = getRichError({
          action: "Creating Sandbox",
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-create-sandbox",
          data: {
            error: { message: richError.error.message },
            status: "error",
          },
        });

        console.log("Error creating Sandbox:", richError.error);
        return richError.message;
      }
    },
  });

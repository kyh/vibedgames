import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import type { JsonValue } from "@repo/contract/json";
import { creditEntry, generation } from "@repo/db/drizzle-schema";
import { user } from "@repo/db/drizzle-schema-auth";
import { call } from "@orpc/server";
import { z } from "zod";

import type { ORPCContext } from "../orpc";
import type { UpstreamReply, UpstreamRequest } from "../upstream.test-utils";
import { MICRO_PER_USD } from "../credits/credit-ledger";
import { holdRecipe } from "../credits/recipe-metering";
import { startD1 } from "../d1.test-utils";
import { createAuth } from "../identity/auth";
import { startUpstream } from "../upstream.test-utils";
import { assetRouter } from "./asset-router";

const d1 = await startD1();

after(d1.close);

const { db } = d1;

const seedUser = async (balanceMicro: number) => {
  await db.delete(generation);
  await db.delete(creditEntry);
  await db.delete(user);
  await db.insert(user).values({ email: "user-1@vibedgames.com", id: "user-1", name: "User" });

  if (balanceMicro > 0) {
    await db.insert(creditEntry).values({
      deltaMicro: balanceMicro,
      id: "grant:user-1",
      kind: "admin_grant",
      userId: "user-1",
    });
  }
};

interface Job {
  status: "queued" | "running" | "done" | "failed";
  userId: string;
  final: JsonValue;
  error: string | null;
  outputs: { bytes: number; contentType: string; name: string }[];
  staleRead?: boolean;
}

const jobs = new Map<string, Job>();
const started: JsonValue[] = [];

const answer = (json: JsonValue, status = 200) => ({ json, status }) satisfies UpstreamReply;

const routeMedia: (request: UpstreamRequest) => UpstreamReply = (request) => {
  const [, _route, id = "", action] = request.url.pathname.split("/");
  const job = jobs.get(id);

  if (action === "start") {
    const body = z.object({ userId: z.string() }).parse(JSON.parse(request.body));
    started.push(z.json().parse(JSON.parse(request.body)));
    jobs.set(id, { error: null, final: null, outputs: [], status: "queued", userId: body.userId });

    return answer({ status: "queued" });
  }

  if (!job) {
    return answer({ error: "no such job" }, 404);
  }

  if (action === "out") {
    return answer({ error: "no longer kept" }, 404);
  }

  if (action === "final") {
    job.final ??= z.json().parse(JSON.parse(request.body));
    job.staleRead = false;
  }

  return answer({
    error: job.error,
    final: job.staleRead === true ? null : job.final,
    outputs: job.outputs,
    recipe: "video-to-sheet",
    result: job.status === "done" ? { frames: 8 } : null,
    seconds: job.status === "queued" ? null : 3,
    status: job.status,
    userId: job.userId,
  });
};

const media = await startUpstream(routeMedia);

after(media.close);

const auth = createAuth({ baseURL: "http://localhost:3000", db, secret: "test-secret" });
const now = new Date();

const contextAs = (userId: string, withMedia = true) => {
  const context: ORPCContext = {
    auth,
    billing: undefined,
    db,
    decision: undefined,
    headers: new Headers(),
    media: undefined,
    mediaJobs: withMedia
      ? {
          fetch: async (request) => {
            const url = new URL(request.url);

            return await fetch(new Request(`${media.origin}${url.pathname}`, request));
          },
        }
      : undefined,
    oauthScopes: null,
    productionURL: undefined,
    r2: undefined,
    sendsEmail: false,
    session: {
      session: {
        createdAt: now,
        expiresAt: now,
        id: `session-${userId}`,
        ipAddress: null,
        token: "session-token",
        updatedAt: now,
        userAgent: null,
        userId,
      },
      user: {
        banned: false,
        createdAt: now,
        email: `${userId}@vibedgames.com`,
        emailVerified: true,
        id: userId,
        name: "User",
        role: "user",
        updatedAt: now,
      },
    },
    signing: undefined,
  };

  return context;
};

const VIDEO = "https://v3.fal.media/files/clip.mp4";

const submit = async (userId = "user-1", withMedia = true) => {
  const job = await call(
    assetRouter.videoToSheet,
    { video_url: VIDEO, wait_seconds: 0 },
    { context: contextAs(userId, withMedia) },
  );

  assert.ok(job.job_id !== null, "a hosted job has an id");

  return { ...job, job_id: job.job_id };
};

const ledgerKinds = async () => {
  const entries = await db.select().from(creditEntry);

  return entries.filter((entry) => entry.id !== "grant:user-1").map((entry) => entry.kind);
};

const generationStatus = async (jobId: string) => {
  const rows = await db.select().from(generation);

  return rows.find((row) => row.requestId === jobId)?.status;
};

const ledgerHas = async (kind: "generation_release") => {
  const kinds = await ledgerKinds();

  return kinds.includes(kind);
};

describe("hosted recipe jobs", () => {
  beforeEach(async () => {
    started.length = 0;
    await seedUser(5 * MICRO_PER_USD);
  });

  test("holds credit, starts the job with its files apart from its parameters", async () => {
    const job = await submit();

    assert.equal(job.status, "queued");
    assert.match(job.job_id, /^rcp_tools_/u);
    assert.deepEqual(await ledgerKinds(), ["generation_hold"]);
    assert.deepEqual(started[0], {
      files: [{ field: "video_url", url: VIDEO }],
      params: { cell_width: 256, columns: 8, fps: 12, max_frames: 64, start_seconds: 0 },
      recipe: "video-to-sheet",
      userId: "user-1",
    });
  });

  test("on done, settles at the floor and closes the job", async () => {
    const { job_id: jobId } = await submit();
    const job = jobs.get(jobId);
    assert.ok(job);
    job.status = "done";

    const done = await call(
      assetRouter.status,
      { job_id: jobId, wait_seconds: 0 },
      { context: contextAs("user-1") },
    );

    assert.equal(done.status, "done");
    assert.equal(done.cost_usd, 0.01);
    assert.deepEqual(done.outputs, []);
    assert.notEqual(job.final, null);
    assert.deepEqual(done.result, { frames: 8 });
    assert.equal(await generationStatus(jobId), "settled");
  });

  test("on failure, releases the hold and reports why", async () => {
    const { job_id: jobId } = await submit();
    const job = jobs.get(jobId);
    assert.ok(job);
    job.status = "failed";
    job.error = "video_url has no video stream.";

    const failed = await call(
      assetRouter.status,
      { job_id: jobId, wait_seconds: 0 },
      { context: contextAs("user-1") },
    );

    assert.equal(failed.status, "failed");
    assert.equal(failed.cost_usd, 0);
    assert.equal(failed.error, "video_url has no video stream.");
    assert.ok(await ledgerHas("generation_release"));
  });

  test("releases the hold when a done job's outputs are no longer kept", async () => {
    const { job_id: jobId } = await submit();
    const job = jobs.get(jobId);
    assert.ok(job);
    job.status = "done";
    job.outputs = [{ bytes: 10, contentType: "image/png", name: "sheet.png" }];

    const done = await call(
      assetRouter.status,
      { job_id: jobId, wait_seconds: 0 },
      { context: contextAs("user-1") },
    );

    assert.equal(done.cost_usd, 0);
    assert.match(done.error ?? "", /no longer kept/u);
    assert.ok(await ledgerHas("generation_release"));
  });

  test("keeps the first final record when two follows finish one job", async () => {
    const { job_id: jobId } = await submit();
    const job = jobs.get(jobId);
    assert.ok(job);
    job.status = "done";

    const follow = async () =>
      await call(
        assetRouter.status,
        { job_id: jobId, wait_seconds: 0 },
        { context: contextAs("user-1") },
      );

    const first = await follow();

    job.outputs = [{ bytes: 10, contentType: "image/png", name: "sheet.png" }];
    job.staleRead = true;

    const second = await follow();

    assert.equal(first.cost_usd, 0.01);
    assert.equal(second.cost_usd, 0.01);
    assert.equal(second.error, null);
  });

  test("hides another account's job", async () => {
    const { job_id: jobId } = await submit();

    await assert.rejects(
      call(
        assetRouter.status,
        { job_id: jobId, wait_seconds: 0 },
        { context: contextAs("user-2") },
      ),
      /No recipe job/u,
    );
  });

  test("refuses a URL off the media hosts before holding anything", async () => {
    await assert.rejects(
      call(
        assetRouter.videoToSheet,
        { video_url: "https://example.com/clip.mp4", wait_seconds: 0 },
        { context: contextAs("user-1") },
      ),
      /only a URL generate/u,
    );
    assert.deepEqual(await ledgerKinds(), []);
  });

  test("refuses at a zero balance, and past two running jobs", async () => {
    await seedUser(0);
    await assert.rejects(submit(), /insufficient_credits/u);
    assert.deepEqual(await ledgerKinds(), []);

    await seedUser(MICRO_PER_USD);
    await holdRecipe(db, { jobId: "rcp_tools_a", recipe: "video-to-sheet", userId: "user-1" });
    await holdRecipe(db, { jobId: "rcp_tools_b", recipe: "video-to-sheet", userId: "user-1" });
    await assert.rejects(submit(), /already running/u);
  });

  test("answers 412 with the local way where no recipe service is bound", async () => {
    await assert.rejects(submit("user-1", false), /vg asset video-to-sheet/u);
  });
});

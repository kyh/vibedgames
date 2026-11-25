import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import type { D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import type { JsonValue } from "@repo/contract/json";
import { createDb } from "@repo/db/drizzle-client";
import { call } from "@orpc/server";

import type { ORPCContext } from "../orpc";
import type { UpstreamReply, UpstreamRequest } from "../upstream.test-utils";
import { MICRO_PER_USD } from "../credits/credit-ledger";
import { createAuth } from "../identity/auth";
import { startUpstream } from "../upstream.test-utils";
import { assetRouter } from "./asset-router";

const unavailable = (): never => {
  throw new Error("this test's database only reads and batches writes");
};

const d1Result = <T>() =>
  ({
    meta: {
      changed_db: false,
      changes: 0,
      duration: 0,
      last_row_id: 0,
      rows_read: 0,
      rows_written: 0,
      size_after: 0,
    },
    results: [],
    success: true,
  }) satisfies D1Result<T>;

const ledger = { balance: 5 * MICRO_PER_USD, running: 0 };
const writes: { query: string; params: unknown[] }[] = [];
const bound = new WeakMap<D1PreparedStatement, { query: string; params: unknown[] }>();

const prepare = (query: string, params: unknown[] = []) => {
  const rows = () => [[query.includes("count(*)") ? ledger.running : ledger.balance]];

  const statement: D1PreparedStatement = {
    all: <T>() => Promise.resolve(d1Result<T>()),
    bind: (...values) => prepare(query, values),
    first: () => Promise.resolve(null),
    raw: (() => Promise.resolve(rows())) as D1PreparedStatement["raw"],
    run: <T>() => Promise.resolve(d1Result<T>()),
  };

  bound.set(statement, { params, query });

  return statement;
};

const db = createDb({
  batch: <T>(statements: D1PreparedStatement[]) => {
    for (const statement of statements) {
      const write = bound.get(statement);

      if (write) {
        writes.push(write);
      }
    }

    return Promise.resolve(statements.map(() => d1Result<T>()));
  },
  dump: unavailable,
  exec: unavailable,
  prepare,
  withSession: unavailable,
});

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
    const body = JSON.parse(request.body) as { userId: string };
    started.push(JSON.parse(request.body) as JsonValue);
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
    job.final ??= JSON.parse(request.body) as JsonValue;
    job.staleRead = false;
  }

  return answer({
    error: job.error,
    final: job.staleRead ? null : job.final,
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
          fetch: (request) => {
            const url = new URL(request.url);

            return fetch(new Request(`${media.origin}${url.pathname}`, request));
          },
        }
      : undefined,
    oauthScopes: null,
    productionURL: undefined,
    r2: undefined,
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

  assert.ok(job.job_id, "a hosted job has an id");

  return { ...job, job_id: job.job_id };
};

const KIND = /'(?<kind>generation_\w+)'/u;

const ledgerKinds = () =>
  writes.flatMap(({ params, query }) =>
    query.startsWith('insert into "credit_entry"')
      ? [KIND.exec(query)?.groups?.kind ?? params.find((p) => String(p).startsWith("generation_"))]
      : [],
  );

describe("hosted recipe jobs", () => {
  beforeEach(() => {
    writes.length = 0;
    started.length = 0;
    ledger.balance = 5 * MICRO_PER_USD;
    ledger.running = 0;
  });

  test("holds credit, starts the job with its files apart from its parameters", async () => {
    const job = await submit();

    assert.equal(job.status, "queued");
    assert.match(job.job_id, /^rcp_tools_/u);
    assert.deepEqual(ledgerKinds(), ["generation_hold"]);
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
    assert.ok(ledgerKinds().includes("generation_settle"));
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
    assert.ok(ledgerKinds().includes("generation_release"));
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
    assert.ok(ledgerKinds().includes("generation_release"));
  });

  test("keeps the first final record when two follows finish one job", async () => {
    const { job_id: jobId } = await submit();
    const job = jobs.get(jobId);
    assert.ok(job);
    job.status = "done";

    const follow = () =>
      call(
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
    assert.deepEqual(ledgerKinds(), []);
  });

  test("refuses at a zero balance, and past two running jobs", async () => {
    ledger.balance = 0;
    await assert.rejects(submit(), /insufficient_credits/u);

    ledger.balance = MICRO_PER_USD;
    ledger.running = 2;
    await assert.rejects(submit(), /already running/u);
    assert.deepEqual(ledgerKinds(), []);
  });

  test("answers 412 with the local way where no recipe service is bound", async () => {
    await assert.rejects(submit("user-1", false), /vg asset video-to-sheet/u);
  });
});

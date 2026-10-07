import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";

import { generateOpenAPISpec } from "./openapi-spec";

const errorRef = z.object({
  content: z.object({
    "application/json": z.object({
      schema: z.object({ $ref: z.literal("#/components/schemas/Error") }),
    }),
  }),
});

const operationSchema = z.object({
  description: z.string().min(1),
  operationId: z.string().min(1),
  responses: z.record(z.string(), z.object({ description: z.string() }).loose()),
  security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
  summary: z.string().min(1),
});

const specSchema = z.object({
  components: z.object({
    schemas: z.object({ Error: z.object({ required: z.array(z.string()) }).loose() }).loose(),
    securitySchemes: z.record(z.string(), z.unknown()),
  }),
  openapi: z.string().startsWith("3.1"),
  paths: z.record(z.string(), z.record(z.string(), operationSchema)),
  servers: z.array(z.object({ url: z.string() })),
});

describe("OpenAPI spec", async () => {
  // Parsing is the assertion that every operation carries an id, a summary and a description.
  const spec = specSchema.parse(await generateOpenAPISpec());
  const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({ method, operation, path })),
  );
  const pathsWith = (predicate: (security: unknown[] | undefined) => boolean) =>
    operations
      .filter(({ operation }) => predicate(operation.security))
      .map(({ path }) => path)
      .toSorted();

  test("serves every procedure as a POST under the /api/v1 server", () => {
    assert.deepEqual(
      spec.servers.map((server) => server.url),
      ["https://vibedgames.com/api/v1"],
    );
    assert.ok(operations.length >= 23, `expected >= 23 operations, got ${operations.length}`);
    assert.ok(operations.every(({ method }) => method === "post"));
    for (const path of ["/auth/me", "/deploy/create", "/generate/forward", "/waitlist/join"]) {
      assert.ok(spec.paths[path], `missing ${path}`);
    }
  });

  test("gives every operation a unique id", () => {
    const ids = operations.map(({ operation }) => operation.operationId);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("describes a JSON success body and the shared error body on every operation", () => {
    for (const { path, operation } of operations) {
      const success = z
        .object({ content: z.object({ "application/json": z.object({ schema: z.unknown() }) }) })
        .safeParse(operation.responses["200"]);
      assert.ok(success.success, `${path} has no JSON 200 response`);
      assert.ok(errorRef.safeParse(operation.responses["400"]).success, `${path} lacks 400`);
      assert.ok(errorRef.safeParse(operation.responses["500"]).success, `${path} lacks 500`);
    }
    assert.deepEqual(spec.components.schemas.Error.required, ["code", "message"]);
  });

  test("declares credentials only on procedures that check them", () => {
    assert.deepEqual(
      pathsWith((security) => security === undefined),
      ["/auth/cliInit", "/auth/cliPoll", "/waitlist/join"],
    );
    for (const { path, operation } of operations) {
      if (operation.security !== undefined) {
        assert.ok(errorRef.safeParse(operation.responses["401"]).success, `${path} lacks 401`);
      }
    }
  });

  test("keeps API keys off the session-only procedures", () => {
    const sessionOnly = pathsWith(
      (security) => security !== undefined && !JSON.stringify(security).includes("apiKeyHeader"),
    );
    assert.ok(sessionOnly.includes("/apiKeys/create"));
    assert.ok(sessionOnly.includes("/admin/users/list"));
    assert.ok(sessionOnly.includes("/auth/cliConfirm"));
    assert.ok(!sessionOnly.includes("/deploy/create"));
  });
});

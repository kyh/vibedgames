import assert from "node:assert/strict";
import { test } from "node:test";

import { requiresCredential } from "./auth-gate";

const post = (body: string) => new Request("http://localhost/mcp", { body, method: "POST" });

const call = (name: string) =>
  post(JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { name } }));

test("account tools need a credential", async () => {
  assert.equal(await requiresCredential(call("generate_submit")), true);
  assert.equal(await requiresCredential(call("whoami")), true);
});

test("discovery and catalog tools stay anonymous", async () => {
  assert.equal(await requiresCredential(call("list_skills")), false);
  assert.equal(
    await requiresCredential(post('{"id":1,"jsonrpc":"2.0","method":"tools/list"}')),
    false,
  );
  assert.equal(await requiresCredential(post("not json")), false);
});

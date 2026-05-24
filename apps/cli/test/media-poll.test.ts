import assert from "node:assert/strict";
import { test } from "node:test";

import { endpointPath, queueAppId } from "../src/lib/media-poll.js";

test("queueAppId drops the model subpath so status/result/cancel hit the app id", () => {
  // fal queues submission under the full id but keys status/result/cancel
  // by owner/app only. Passing the subpath returns 405.
  assert.equal(queueAppId("fal-ai/flux/schnell"), "fal-ai/flux");
  assert.equal(queueAppId("fal-ai/flux/dev"), "fal-ai/flux");
  assert.equal(queueAppId("openai/gpt-image-2/edit"), "openai/gpt-image-2");
});

test("queueAppId leaves a bare owner/app id untouched", () => {
  assert.equal(queueAppId("fal-ai/flux"), "fal-ai/flux");
});

test("queueAppId keeps three segments for namespaced ids (workflows/comfy)", () => {
  assert.equal(queueAppId("workflows/owner/my-flow"), "workflows/owner/my-flow");
  assert.equal(queueAppId("workflows/owner/my-flow/run"), "workflows/owner/my-flow");
  assert.equal(queueAppId("comfy/owner/graph/extra"), "comfy/owner/graph");
});

test("queueAppId tolerates leading/trailing slashes", () => {
  assert.equal(queueAppId("/fal-ai/flux/schnell/"), "fal-ai/flux");
});

test("endpointPath keeps the full id for submission", () => {
  assert.equal(endpointPath("fal-ai/flux/schnell"), "fal-ai/flux/schnell");
  assert.equal(endpointPath("/fal-ai/flux/schnell/"), "fal-ai/flux/schnell");
});

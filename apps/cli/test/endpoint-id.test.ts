import assert from "node:assert/strict";
import { test } from "node:test";

import { displayEndpointId, resolveEndpointId } from "../src/lib/endpoint-id.js";

test("resolveEndpointId prepends the default owner to a bare display id", () => {
  assert.equal(resolveEndpointId("flux/dev"), "fal-ai/flux/dev");
  assert.equal(resolveEndpointId("nano-banana-pro"), "fal-ai/nano-banana-pro");
  assert.equal(resolveEndpointId("nano-banana-pro/edit"), "fal-ai/nano-banana-pro/edit");
});

test("resolveEndpointId leaves an already default-owned id untouched", () => {
  assert.equal(resolveEndpointId("fal-ai/flux/dev"), "fal-ai/flux/dev");
});

test("resolveEndpointId leaves other provider namespaces untouched", () => {
  assert.equal(resolveEndpointId("openai/gpt-image-1"), "openai/gpt-image-1");
  assert.equal(resolveEndpointId("bytedance/seedance"), "bytedance/seedance");
  assert.equal(resolveEndpointId("veed/avatars"), "veed/avatars");
});

test("resolveEndpointId leaves queue namespaces (workflows/comfy) untouched", () => {
  assert.equal(resolveEndpointId("workflows/owner/my-flow"), "workflows/owner/my-flow");
  assert.equal(resolveEndpointId("comfy/owner/graph"), "comfy/owner/graph");
});

test("resolveEndpointId tolerates leading/trailing slashes", () => {
  assert.equal(resolveEndpointId("/flux/dev/"), "fal-ai/flux/dev");
  assert.equal(resolveEndpointId("/fal-ai/flux/dev/"), "fal-ai/flux/dev");
});

test("displayEndpointId strips the default owner prefix when redundant", () => {
  assert.equal(displayEndpointId("fal-ai/flux/dev"), "flux/dev");
  assert.equal(displayEndpointId("fal-ai/nano-banana-pro"), "nano-banana-pro");
  assert.equal(displayEndpointId("fal-ai/elevenlabs/tts"), "elevenlabs/tts");
  assert.equal(displayEndpointId("openai/gpt-image-1"), "openai/gpt-image-1");
  assert.equal(displayEndpointId("workflows/owner/my-flow"), "workflows/owner/my-flow");
});

test("displayEndpointId keeps the prefix when stripping would be ambiguous", () => {
  // `bytedance` exists both under the default owner and as a standalone
  // namespace, so the prefix is load-bearing and must survive.
  assert.equal(displayEndpointId("fal-ai/bytedance/seedream"), "fal-ai/bytedance/seedream");
  assert.equal(resolveEndpointId("bytedance/seedance"), "bytedance/seedance");
});

test("display and resolve round-trip", () => {
  for (const real of [
    "fal-ai/flux/dev",
    "fal-ai/nano-banana-pro/edit",
    "fal-ai/elevenlabs/tts",
    "fal-ai/bytedance/seedream",
    "openai/gpt-image-1",
    "bytedance/seedance",
    "workflows/owner/my-flow",
  ]) {
    assert.equal(resolveEndpointId(displayEndpointId(real)), real);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { displayEndpointId, resolveEndpointId } from "../src/lib/endpoint-id.js";

test("resolveEndpointId prepends the default owner to a known app", () => {
  assert.equal(resolveEndpointId("flux/dev"), "fal-ai/flux/dev");
  assert.equal(resolveEndpointId("nano-banana-pro"), "fal-ai/nano-banana-pro");
  assert.equal(resolveEndpointId("nano-banana-pro/edit"), "fal-ai/nano-banana-pro/edit");
  assert.equal(resolveEndpointId("bria/background/remove"), "fal-ai/bria/background/remove");
});

test("resolveEndpointId leaves an already default-owned id untouched", () => {
  assert.equal(resolveEndpointId("fal-ai/flux/dev"), "fal-ai/flux/dev");
});

test("resolveEndpointId leaves other top-level owners untouched", () => {
  // Regression: these owners are NOT under the default owner. Prepending the
  // prefix would point at a non-existent endpoint.
  assert.equal(resolveEndpointId("tripo3d/h3.1/image-to-3d"), "tripo3d/h3.1/image-to-3d");
  assert.equal(resolveEndpointId("pixelcut/background-removal"), "pixelcut/background-removal");
  assert.equal(resolveEndpointId("clarityai/crystal-upscaler"), "clarityai/crystal-upscaler");
  assert.equal(resolveEndpointId("openai/gpt-image-2"), "openai/gpt-image-2");
  assert.equal(resolveEndpointId("bytedance/seedance"), "bytedance/seedance");
  assert.equal(resolveEndpointId("workflows/owner/my-flow"), "workflows/owner/my-flow");
});

test("resolveEndpointId leaves an unknown app untouched (graceful, not wrong)", () => {
  assert.equal(resolveEndpointId("some-brand-new-app/v1"), "some-brand-new-app/v1");
});

test("resolveEndpointId tolerates leading/trailing slashes", () => {
  assert.equal(resolveEndpointId("/flux/dev/"), "fal-ai/flux/dev");
  assert.equal(resolveEndpointId("/fal-ai/flux/dev/"), "fal-ai/flux/dev");
});

test("displayEndpointId strips the prefix for a known app", () => {
  assert.equal(displayEndpointId("fal-ai/flux/dev"), "flux/dev");
  assert.equal(displayEndpointId("fal-ai/nano-banana-pro"), "nano-banana-pro");
  assert.equal(displayEndpointId("fal-ai/elevenlabs/tts"), "elevenlabs/tts");
});

test("displayEndpointId keeps the prefix for non-apps and unknown apps", () => {
  // `bytedance` is a default-owner sub-namespace AND a standalone owner, so its
  // prefix is load-bearing and must survive.
  assert.equal(displayEndpointId("fal-ai/bytedance/seedream"), "fal-ai/bytedance/seedream");
  // An app we don't know about keeps its prefix rather than risk a bad strip.
  assert.equal(displayEndpointId("fal-ai/some-brand-new-app"), "fal-ai/some-brand-new-app");
  // Other owners are already prefix-free.
  assert.equal(displayEndpointId("openai/gpt-image-2"), "openai/gpt-image-2");
  assert.equal(displayEndpointId("tripo3d/h3.1/image-to-3d"), "tripo3d/h3.1/image-to-3d");
});

test("display and resolve round-trip losslessly", () => {
  for (const real of [
    "fal-ai/flux/dev",
    "fal-ai/nano-banana-pro/edit",
    "fal-ai/elevenlabs/tts",
    "fal-ai/bytedance/seedream",
    "fal-ai/some-brand-new-app",
    "openai/gpt-image-2",
    "tripo3d/h3.1/image-to-3d",
    "bytedance/seedance",
    "workflows/owner/my-flow",
  ]) {
    assert.equal(resolveEndpointId(displayEndpointId(real)), real);
  }
});

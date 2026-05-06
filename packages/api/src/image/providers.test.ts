import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { falImageProvider } from "./providers/fal";
import { openaiImageProvider } from "./providers/openai";
import { retroDiffusionImageProvider } from "./providers/retro-diffusion";
import type { ImageInputFile, ImageInputRole } from "./types";

const originalFetch = globalThis.fetch;
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X8WV4AAAAASUVORK5CYII=";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function image(role: ImageInputRole, filename = `${role}.png`): ImageInputFile {
  return {
    role,
    filename,
    contentType: "image/png",
    bytes: pngBytes,
    url: `https://r2.test/${filename}`,
  };
}

function jsonResponse(value: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Expected record.");
  }
  return value;
}

function installFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): void {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    return await handler(url, init);
  };
}

test("OpenAI maps image/reference roles to edit images and mask role to mask", async () => {
  const capturedForm: { value: FormData | null } = { value: null };
  let capturedRedirect: RequestInit["redirect"] | undefined;
  installFetch((_url, init) => {
    capturedRedirect = init?.redirect;
    const body = init?.body;
    if (!(body instanceof FormData)) {
      throw new Error("Expected multipart body.");
    }
    capturedForm.value = body;
    return jsonResponse({ data: [{ b64_json: pngBase64 }], created: 1, usage: {} });
  });

  const result = await openaiImageProvider.run({
    task: "edit",
    model: "gpt-image-1.5",
    prompt: "edit",
    params: { input_fidelity: "high" },
    inputImages: [image("image"), image("reference"), image("mask")],
    apiKey: "openai-key",
  });

  const form = capturedForm.value;
  if (!form) throw new Error("Expected captured form.");
  assert.equal(capturedRedirect, "manual");
  assert.equal(form.get("model"), "gpt-image-1.5");
  assert.equal(form.get("prompt"), "edit");
  assert.equal(form.get("input_fidelity"), "high");
  assert.equal(form.getAll("image[]").length, 2);
  assert.equal(form.has("mask"), true);
  assert.equal(result.outputs.length, 1);
});

test("OpenAI rejects image-like params instead of forwarding inline bytes", async () => {
  await assert.rejects(
    () =>
      openaiImageProvider.run({
        task: "edit",
        model: "gpt-image-1.5",
        prompt: "edit",
        params: { mask: "inline-base64" },
        inputImages: [image("image")],
        apiKey: "openai-key",
      }),
    /OpenAI image fields must use uploaded image roles, not params: mask/,
  );
});

test("Retro Diffusion maps image, reference, and palette roles to native fields", async () => {
  let capturedPayload: unknown = null;
  let capturedRedirect: RequestInit["redirect"] | undefined;
  installFetch((_url, init) => {
    capturedRedirect = init?.redirect;
    const body = init?.body;
    if (typeof body !== "string") {
      throw new Error("Expected JSON body.");
    }
    capturedPayload = JSON.parse(body);
    return jsonResponse({ base64_images: [pngBase64], balance_cost: 1 });
  });

  const result = await retroDiffusionImageProvider.run({
    task: "generate",
    model: "rd_pro__edit",
    prompt: "sprite",
    params: {
      width: 64,
      height: 64,
      // All three should be stripped by RESERVED_FIELDS — `prompt_style`
      // in particular must not override the proxy-controlled value
      // derived from `req.model`, since the response metadata reports
      // `req.model` and a silent swap would mislead the caller.
      model: "not-forwarded",
      prompt: "not-forwarded",
      prompt_style: "not-forwarded",
    },
    inputImages: [image("image"), image("reference"), image("palette")],
    apiKey: "rd-key",
  });

  const payload = record(capturedPayload);
  assert.equal(capturedRedirect, "manual");
  assert.equal(payload.prompt_style, "rd_pro__edit");
  assert.equal(payload.prompt, "sprite");
  assert.equal(payload.model, undefined);
  assert.equal(typeof payload.input_image, "string");
  assert.equal(typeof payload.input_palette, "string");
  assert.ok(Array.isArray(payload.reference_images));
  assert.equal(payload.reference_images.length, 1);
  assert.equal(result.outputs.length, 1);
});

test("fal maps image/reference roles into configured image field", async () => {
  let capturedPayload: unknown = null;
  installFetch((url, init) => {
    if (url === "https://queue.fal.run/fal-ai/test") {
      const body = init?.body;
      if (typeof body !== "string") {
        throw new Error("Expected queue JSON body.");
      }
      capturedPayload = JSON.parse(body);
      return jsonResponse({
        request_id: "req",
        status_url: "https://queue.fal.run/fal-ai/test/requests/req/status",
        response_url: "https://queue.fal.run/fal-ai/test/requests/req",
      });
    }
    if (url === "https://queue.fal.run/fal-ai/test/requests/req/status?logs=0") {
      return jsonResponse({ status: "COMPLETED" });
    }
    if (url === "https://queue.fal.run/fal-ai/test/requests/req") {
      return jsonResponse(
        { images: [{ url: "https://cdn.fal.media/out.png", content_type: "image/png" }] },
        { "x-fal-billable-units": "1" },
      );
    }
    if (url === "https://cdn.fal.media/out.png") {
      return new Response(pngBytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(pngBytes.byteLength),
        },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const result = await falImageProvider.run({
    task: "edit",
    model: "fal-ai/test",
    prompt: "sprite",
    params: {
      input_image_field: "image_urls",
      image_urls: ["https://example.test/existing.png"],
    },
    inputImages: [image("image"), image("reference")],
    apiKey: "fal-key",
  });

  const payload = record(capturedPayload);
  assert.ok(Array.isArray(payload.image_urls));
  assert.equal(payload.image_urls.length, 3);
  assert.equal(payload.image_urls[0], "https://r2.test/image.png");
  assert.equal(payload.image_urls[1], "https://r2.test/reference.png");
  assert.equal(payload.image_urls[2], "https://example.test/existing.png");
  assert.equal(result.outputs.length, 1);
  assert.equal(result.metadata.billable_units, "1");
});

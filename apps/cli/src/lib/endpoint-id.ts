// Endpoint-id aliasing.
//
// `vg generate` is a generative-asset CLI. Most model endpoints live under a
// single default owner namespace, which is an implementation detail users
// shouldn't have to type or read. So the CLI speaks two forms:
//
//   - display form  — what we print and what authored examples use
//                     (`flux/dev`, `nano-banana-pro`)
//   - resolved form — what the upstream queue/platform APIs expect
//                     (`fal-ai/flux/dev`, `fal-ai/nano-banana-pro`)
//
// Aliasing is keyed off a known set of *default-owner apps* (DEFAULT_OWNER_APPS
// below), NOT a denylist of other owners. The gateway hosts unboundedly many
// top-level owners (`openai/`, `tripo3d/`, `pixelcut/`, …), so we can't safely
// assume "anything unqualified belongs to the default owner." Instead:
//
//   - resolveEndpointId prepends the default owner ONLY when the first segment
//     is a known app. Every other id — other owners, already-qualified ids,
//     and default-owner apps we don't know about — passes through unchanged.
//   - displayEndpointId strips the default owner prefix ONLY when it wraps a
//     known app.
//
// This makes the round-trip lossless (`resolveEndpointId(displayEndpointId(id))
// === id` for every id) and means an unlisted app degrades gracefully: it just
// shows its owner prefix. It never yields a wrong id for some other owner.

const DEFAULT_OWNER = "fal-ai";
const DEFAULT_OWNER_PREFIX = `${DEFAULT_OWNER}/`;

// Apps hosted directly under the default owner that the skills reference by
// short name. Derived from the endpoints the skills document — extend it as
// skills add models. Sub-namespaces that double as standalone owners
// (`bytedance`, etc.) are deliberately absent: their ids keep the explicit
// `fal-ai/` prefix so they don't collide with the top-level owner of the same
// name.
const DEFAULT_OWNER_APPS = new Set<string>([
  "auto-caption",
  "birefnet",
  "bria",
  "bytedance-upscaler",
  "chatterbox",
  "codeformer",
  "creatify",
  "demucs",
  "docres",
  "elevenlabs",
  "fashn",
  "ffmpeg-api",
  "flashtalk",
  "florence-2-large",
  "flux",
  "flux-2",
  "got-ocr",
  "gpt-image-2",
  "hunyuan-3d",
  "hunyuan-avatar",
  "hunyuan-custom",
  "hunyuan-portrait",
  "hunyuan3d",
  "hunyuan3d-v3",
  "hyper3d",
  "ideogram",
  "image-apps-v2",
  "kling-image",
  "kling-video",
  "kokoro",
  "lyria2",
  "meshy",
  "minimax",
  "minimax-music",
  "mix-dehaze-net",
  "mmaudio-v2",
  "moondream2",
  "moondream3-preview",
  "nafnet",
  "nano-banana-2",
  "nano-banana-pro",
  "patina",
  "pixverse",
  "qwen-3-tts",
  "qwen-image-2512",
  "qwen-image-edit-2509-lora-gallery",
  "qwen-image-edit-plus",
  "qwen-image-edit-plus-lora-gallery",
  "recraft",
  "sam-3",
  "sam-audio",
  "seedvr",
  "sora-2",
  "speech-to-text",
  "stable-audio-25",
  "sync-lipsync",
  "topaz",
  "trellis",
  "triposr",
  "veo3.1",
  "video-understanding",
  "vidu",
  "wan",
  "wan-flf2v",
  "wan-fun-control",
  "wan-vace-apps",
  "wan-vision-enhancer",
  "wizper",
  "workflow-utilities",
  "z-image",
]);

function trim(id: string): string {
  return id.replace(/^\/+|\/+$/g, "");
}

function firstSegment(id: string): string {
  return id.split("/", 1)[0] ?? "";
}

/**
 * Expand a display id to the form the upstream APIs expect. Only known
 * default-owner apps get the prefix; every other id (other owners,
 * already-qualified ids, unknown apps) is returned unchanged.
 */
export function resolveEndpointId(id: string): string {
  const clean = trim(id);
  if (clean.length === 0) return clean;
  return DEFAULT_OWNER_APPS.has(firstSegment(clean))
    ? `${DEFAULT_OWNER_PREFIX}${clean}`
    : clean;
}

/**
 * Strip the default owner prefix for human-facing output — but only when it
 * wraps a known app, so the round-trip stays lossless. Ids under another owner
 * (or under a default-owner sub-namespace we don't alias) keep their owner so
 * they stay runnable exactly as printed.
 */
export function displayEndpointId(id: string): string {
  const clean = trim(id);
  if (!clean.startsWith(DEFAULT_OWNER_PREFIX)) return clean;
  const rest = clean.slice(DEFAULT_OWNER_PREFIX.length);
  return DEFAULT_OWNER_APPS.has(firstSegment(rest)) ? rest : clean;
}

import type { ImageProviderName } from "@repo/api/image/types";
import { IMAGE_PROVIDERS } from "@repo/api/image/types";

const DEFAULT_PROVIDER: ImageProviderName = "openai";

/**
 * Short aliases for common provider+model combinations. Users can pass
 * either a fully-qualified `provider:model` spec, the model id alone (if
 * unambiguous), or one of these aliases.
 */
const ALIASES: Record<string, { provider: ImageProviderName; model: string }> = {
  // OpenAI
  "gpt-image-1.5": { provider: "openai", model: "gpt-image-1.5" },
  "gpt-image-1": { provider: "openai", model: "gpt-image-1" },
  "dall-e-3": { provider: "openai", model: "dall-e-3" },
  "dall-e-2": { provider: "openai", model: "dall-e-2" },
  // fal
  "nano-banana-2": { provider: "fal", model: "fal-ai/nano-banana-2" },
  "nano-banana-2-edit": {
    provider: "fal",
    model: "fal-ai/nano-banana-2/edit",
  },
  "nano-banana-pro": { provider: "fal", model: "fal-ai/nano-banana-pro" },
  "nano-banana-pro-edit": {
    provider: "fal",
    model: "fal-ai/nano-banana-pro/edit",
  },
  "grok-imagine-image": { provider: "fal", model: "xai/grok-imagine-image" },
  "grok-imagine-image-edit": {
    provider: "fal",
    model: "xai/grok-imagine-image/edit",
  },
  // Retro Diffusion (prompt_style)
  "rd-pro-platformer": { provider: "retro-diffusion", model: "rd_pro__platformer" },
  "rd-pro-edit": { provider: "retro-diffusion", model: "rd_pro__edit" },
  "rd-pro-spritesheet": {
    provider: "retro-diffusion",
    model: "rd_pro__spritesheet",
  },
};

export type ModelSpec = {
  provider: ImageProviderName;
  model: string;
  /** The original spec as the user typed it, used for log lines. */
  display: string;
};

/**
 * Parse one or more `--model` specs (comma-separated). Each entry can be:
 *
 *   - `provider:model` (e.g. `openai:gpt-image-1.5`, `fal:fal-ai/nano-banana-2`)
 *   - a known alias (e.g. `gpt-image-1.5`, `nano-banana-pro-edit`)
 *   - a model id alone (defaults to `--provider` or `openai`)
 */
export function parseModelSpecs(
  raw: string | undefined,
  defaultProvider: ImageProviderName | undefined,
): ModelSpec[] {
  if (!raw || raw.trim().length === 0) return [];
  const fallbackProvider = defaultProvider ?? DEFAULT_PROVIDER;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => parseOne(entry, fallbackProvider));
}

function parseOne(
  entry: string,
  fallbackProvider: ImageProviderName,
): ModelSpec {
  const aliased = ALIASES[entry];
  if (aliased) return { ...aliased, display: entry };

  const colon = entry.indexOf(":");
  if (colon !== -1) {
    const provider = entry.slice(0, colon);
    const model = entry.slice(colon + 1);
    if (provider.length === 0) {
      throw new Error(
        `provider missing before ":" in "${entry}". Expected one of: ${IMAGE_PROVIDERS.join(", ")}`,
      );
    }
    if (!IMAGE_PROVIDERS.includes(provider as ImageProviderName)) {
      throw new Error(
        `unknown provider in "${entry}". Expected one of: ${IMAGE_PROVIDERS.join(", ")}`,
      );
    }
    if (model.length === 0) {
      throw new Error(`model id missing after ":" in "${entry}"`);
    }
    return { provider: provider as ImageProviderName, model, display: entry };
  }

  return { provider: fallbackProvider, model: entry, display: entry };
}

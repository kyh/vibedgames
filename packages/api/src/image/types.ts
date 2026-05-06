/**
 * Shared shapes for the image generation proxy.
 *
 * Each provider implementation receives a normalized request and returns a
 * normalized result. The router is responsible for moving bytes to R2 and
 * presigning download URLs — providers only know how to talk to their API.
 */

export const IMAGE_PROVIDERS = ["openai", "fal", "retro-diffusion"] as const;
export type ImageProviderName = (typeof IMAGE_PROVIDERS)[number];

export type ImageInputRole = "image" | "reference" | "mask" | "palette";

export type ImageInputFile = {
  role: ImageInputRole;
  filename: string;
  contentType: string;
  /**
   * Raw bytes for byte-consuming providers (OpenAI multipart, Retro Diffusion
   * base64). Empty for fal-bound inputs, which read directly from `url`.
   */
  bytes: Uint8Array;
  /**
   * Presigned R2 GET URL for the input. Always populated. fal reads images
   * via this URL directly, avoiding base64 inflation in the request body.
   */
  url: string;
};

export type ImageProviderRequest = {
  task: "generate" | "edit";
  model: string;
  prompt: string;
  params: Record<string, unknown>;
  inputImages: ImageInputFile[];
  apiKey: string;
  /** Optional override for the upstream base URL (e.g. CF AI Gateway). */
  baseUrl?: string;
};

export type ImageOutput = {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
};

export type ImageProviderResult = {
  outputs: ImageOutput[];
  metadata: Record<string, unknown>;
};

export type ImageProvider = {
  run(req: ImageProviderRequest): Promise<ImageProviderResult>;
};

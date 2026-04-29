/**
 * Shared shapes for the image generation proxy.
 *
 * Each provider implementation receives a normalized request and returns a
 * normalized result. The router is responsible for moving bytes to R2 and
 * presigning download URLs — providers only know how to talk to their API.
 */

export type ImageInputFile = {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
};

export type ImageProviderRequest = {
  task: "generate" | "edit";
  model: string;
  prompt: string;
  params: Record<string, unknown>;
  inputImages: ImageInputFile[];
  apiKey: string;
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

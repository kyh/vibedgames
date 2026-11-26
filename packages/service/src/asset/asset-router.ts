import type { addAnimationsInput } from "@repo/contract/asset/recipe-schema";
import type { z } from "zod";
import { MAX_ASSET_BYTES } from "@repo/contract/asset/asset-schema";
import { isMediaUrl } from "@repo/contract/generate/media-hosts";
import { ORPCError } from "@orpc/server";

import type { ORPCContext } from "../orpc";
import { storeFile } from "../generate/generate-router";
import { readBytesBounded } from "../generate/provider-io";
import { os, requireSession } from "../orpc";
import { inspectGlb, mergeClipsGlb, optimizeGlb, SkeletonMismatchError } from "./gltf-ops";
import { recipeStatus, submitRecipe } from "./recipe-jobs";

const GLB = "model/gltf-binary";

type AddAnimations = z.infer<typeof addAnimationsInput>;

const fetchModel = async (url: string, label: string) => {
  if (!isMediaUrl(url)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `${label}: only a URL generate or an asset procedure returned can be read; put a local file through generate upload first.`,
    });
  }

  let response: Response;

  try {
    response = await fetch(url);
  } catch (error) {
    throw new ORPCError("BAD_GATEWAY", {
      cause: error,
      message: `${label}: ${url} could not be reached.`,
    });
  }

  if (!isMediaUrl(response.url || url)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `${label}: ${url} redirected off the media hosts.`,
    });
  }

  if (!response.ok) {
    throw new ORPCError("BAD_GATEWAY", {
      message: `${label}: fetching ${url} failed (${response.status}).`,
    });
  }

  try {
    return await readBytesBounded(response, MAX_ASSET_BYTES, label);
  } catch (error) {
    if (
      error instanceof ORPCError &&
      error.message === `${label} exceeded ${MAX_ASSET_BYTES} bytes.`
    ) {
      throw new ORPCError("PAYLOAD_TOO_LARGE", {
        cause: error,
        message: `${label} is over ${MAX_ASSET_BYTES} bytes, more than this step holds in memory; shrink its textures first with \`vg asset texture-compress\`.`,
      });
    }

    throw new ORPCError("BAD_GATEWAY", {
      cause: error,
      message: `${label}: reading ${url} failed partway; try again.`,
    });
  }
};

const stemOf = (url: string) => {
  const last = new URL(url).pathname.split("/").at(-1) ?? "";
  const stem = last.replace(/\.[^.]*$/u, "").replaceAll(/[^\w.-]/gu, "_");

  return stem || "model";
};

const store = async (
  context: ORPCContext,
  bytes: Uint8Array<ArrayBuffer>,
  from: string,
  suffix: string,
) =>
  await storeFile(context, { bytes, contentType: GLB, fileName: `${stemOf(from)}-${suffix}.glb` });

const fetchEach = async function* fetchEach(urls: readonly string[]) {
  for (const [index, url] of urls.entries()) {
    yield fetchModel(url, `animation_urls[${index}]`);
  }
};

const GLTF_PATH = /\.(?:glb|gltf)$/iu;

const UNREADABLE_GLB = / is not a GLB this can read: /u;

const blenderCanTake = (error: Error) =>
  error instanceof SkeletonMismatchError ||
  (error instanceof ORPCError &&
    (error.code === "PAYLOAD_TOO_LARGE" ||
      (error.code === "BAD_REQUEST" && UNREADABLE_GLB.test(error.message))));

const mergeSameRig = async (input: AddAnimations) => {
  try {
    const base = await fetchModel(input.model_url, "model_url");

    return await mergeClipsGlb(base, fetchEach(input.animation_urls), input);
  } catch (error) {
    if (error instanceof Error && blenderCanTake(error)) {
      return null;
    }

    throw error;
  }
};

const sameRigMerge = async (context: ORPCContext, input: AddAnimations) => {
  if (!input.animation_urls.every((url) => GLTF_PATH.test(new URL(url).pathname))) {
    return null;
  }

  const merged = await mergeSameRig(input);

  if (!merged) {
    return null;
  }

  const url = await store(context, merged.bytes, input.model_url, "animated");

  return {
    cost_usd: 0,
    error: null,
    job_id: null,
    outputs: [{ bytes: merged.bytes.byteLength, content_type: GLB, name: "model.glb", url }],
    recipe: "add-animations",
    result: {
      animations: merged.stats.animations.map((a) => a.name),
      skipped_channels: merged.skipped_channels,
    },
    seconds: null,
    status: "done" as const,
  };
};

const authed = os.asset.use(requireSession);

export const assetRouter = {
  addAnimations: authed.addAnimations.handler(async ({ context, input }) => {
    if (input.names !== undefined && input.names.length !== input.animation_urls.length) {
      throw new ORPCError("BAD_REQUEST", {
        message: `names has ${input.names.length} entries for ${input.animation_urls.length} animation_urls; give one per animation or none.`,
      });
    }

    return await ((await sameRigMerge(context, input)) ??
      submitRecipe(context, "add-animations", input));
  }),
  audioMaster: authed.audioMaster.handler(
    async ({ context, input }) => await submitRecipe(context, "audio-master", input),
  ),
  bake: authed.bake.handler(
    async ({ context, input }) => await submitRecipe(context, "bake", input),
  ),
  fbxToGlb: authed.fbxToGlb.handler(
    async ({ context, input }) => await submitRecipe(context, "fbx-to-glb", input),
  ),
  framesToVideo: authed.framesToVideo.handler(
    async ({ context, input }) => await submitRecipe(context, "frames-to-video", input),
  ),
  imageToThreejs: authed.imageToThreejs.handler(
    async ({ context, input }) => await submitRecipe(context, "image-to-threejs", input),
  ),
  inspect: authed.inspect.handler(
    async ({ input }) => await inspectGlb(await fetchModel(input.model_url, "model_url")),
  ),

  optimize: authed.optimize.handler(async ({ context, input }) => {
    const { model_url: url, ...options } = input;
    const optimized = await optimizeGlb(await fetchModel(url, "model_url"), options);

    return {
      model_url: await store(context, optimized.bytes, url, "optimized"),
      stats: optimized.stats,
    };
  }),

  render: authed.render.handler(
    async ({ context, input }) => await submitRecipe(context, "render", input),
  ),
  status: authed.status.handler(async ({ context, input }) => await recipeStatus(context, input)),
  textureCompress: authed.textureCompress.handler(
    async ({ context, input }) => await submitRecipe(context, "texture-compress", input),
  ),
  trailerRender: authed.trailerRender.handler(
    async ({ context, input }) => await submitRecipe(context, "trailer-render", input),
  ),
  videoProbe: authed.videoProbe.handler(
    async ({ context, input }) => await submitRecipe(context, "video-probe", input),
  ),
  videoToSheet: authed.videoToSheet.handler(
    async ({ context, input }) => await submitRecipe(context, "video-to-sheet", input),
  ),
};

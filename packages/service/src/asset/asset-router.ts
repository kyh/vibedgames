import type { addAnimationsInput } from "@repo/contract/asset/recipe-schema";
import type { z } from "zod";
import { MAX_ASSET_BYTES } from "@repo/contract/asset/asset-schema";
import { isMediaUrl } from "@repo/contract/generate/media-hosts";
import { ORPCError } from "@orpc/server";

import type { ORPCContext } from "../orpc";
import { storeFile } from "../generate/generate-router";
import { readBytesBounded } from "../generate/provider-io";
import { os, requireSession } from "../orpc";
import { inspectGlb, mergeClipsGlb, optimizeGlb } from "./gltf-ops";
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

const store = (
  context: ORPCContext,
  bytes: Uint8Array<ArrayBuffer>,
  from: string,
  suffix: string,
) => storeFile(context, { bytes, contentType: GLB, fileName: `${stemOf(from)}-${suffix}.glb` });

const fetchEach = async function* fetchEach(urls: readonly string[]) {
  for (const [index, url] of urls.entries()) {
    yield await fetchModel(url, `animation_urls[${index}]`);
  }
};

const GLTF_PATH = /\.(?:glb|gltf)$/iu;

const sameRigMerge = async (context: ORPCContext, input: AddAnimations) => {
  if (!input.animation_urls.every((url) => GLTF_PATH.test(new URL(url).pathname))) {
    return null;
  }

  try {
    const base = await fetchModel(input.model_url, "model_url");
    const merged = await mergeClipsGlb(base, fetchEach(input.animation_urls), input);
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
  } catch {
    return null;
  }
};

const authed = os.asset.use(requireSession);

export const assetRouter = {
  addAnimations: authed.addAnimations.handler(async ({ context, input }) => {
    if (input.names !== undefined && input.names.length !== input.animation_urls.length) {
      throw new ORPCError("BAD_REQUEST", {
        message: `names has ${input.names.length} entries for ${input.animation_urls.length} animation_urls; give one per animation or none.`,
      });
    }

    return (await sameRigMerge(context, input)) ?? submitRecipe(context, "add-animations", input);
  }),
  audioMaster: authed.audioMaster.handler(({ context, input }) =>
    submitRecipe(context, "audio-master", input),
  ),
  bake: authed.bake.handler(({ context, input }) => submitRecipe(context, "bake", input)),
  fbxToGlb: authed.fbxToGlb.handler(({ context, input }) =>
    submitRecipe(context, "fbx-to-glb", input),
  ),
  framesToVideo: authed.framesToVideo.handler(({ context, input }) =>
    submitRecipe(context, "frames-to-video", input),
  ),
  imageToThreejs: authed.imageToThreejs.handler(({ context, input }) =>
    submitRecipe(context, "image-to-threejs", input),
  ),
  inspect: authed.inspect.handler(async ({ input }) =>
    inspectGlb(await fetchModel(input.model_url, "model_url")),
  ),

  optimize: authed.optimize.handler(async ({ context, input }) => {
    const { model_url: url, ...options } = input;
    const optimized = await optimizeGlb(await fetchModel(url, "model_url"), options);

    return {
      model_url: await store(context, optimized.bytes, url, "optimized"),
      stats: optimized.stats,
    };
  }),

  render: authed.render.handler(({ context, input }) => submitRecipe(context, "render", input)),
  status: authed.status.handler(({ context, input }) => recipeStatus(context, input)),
  textureCompress: authed.textureCompress.handler(({ context, input }) =>
    submitRecipe(context, "texture-compress", input),
  ),
  trailerRender: authed.trailerRender.handler(({ context, input }) =>
    submitRecipe(context, "trailer-render", input),
  ),
  videoProbe: authed.videoProbe.handler(({ context, input }) =>
    submitRecipe(context, "video-probe", input),
  ),
  videoToSheet: authed.videoToSheet.handler(({ context, input }) =>
    submitRecipe(context, "video-to-sheet", input),
  ),
};

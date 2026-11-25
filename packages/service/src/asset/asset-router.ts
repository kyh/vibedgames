import { MAX_ASSET_BYTES } from "@repo/contract/asset/asset-schema";
import { isMediaUrl } from "@repo/contract/generate/media-hosts";
import { ORPCError } from "@orpc/server";

import type { ORPCContext } from "../orpc";
import { storeFile } from "../generate/generate-router";
import { readBytesBounded } from "../generate/provider-io";
import { os, requireSession } from "../orpc";
import { inspectGlb, mergeClipsGlb, optimizeGlb } from "./gltf-ops";

const GLB = "model/gltf-binary";

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
    throw new ORPCError("PAYLOAD_TOO_LARGE", {
      cause: error,
      message: `${label} is over ${MAX_ASSET_BYTES} bytes; simplify it with a lower target_polycount when generating.`,
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
    yield await fetchModel(url, `clip_urls[${index}]`);
  }
};

const authed = os.asset.use(requireSession);

export const assetRouter = {
  inspect: authed.inspect.handler(async ({ input }) =>
    inspectGlb(await fetchModel(input.model_url, "model_url")),
  ),

  mergeClips: authed.mergeClips.handler(async ({ context, input }) => {
    if (input.names !== undefined && input.names.length !== input.clip_urls.length) {
      throw new ORPCError("BAD_REQUEST", {
        message: `names has ${input.names.length} entries for ${input.clip_urls.length} clip_urls; give one per clip or none.`,
      });
    }

    const base = await fetchModel(input.model_url, "model_url");
    const merged = await mergeClipsGlb(base, fetchEach(input.clip_urls), input);

    return {
      model_url: await store(context, merged.bytes, input.model_url, "clips"),
      skipped_channels: merged.skipped_channels,
      stats: merged.stats,
    };
  }),

  optimize: authed.optimize.handler(async ({ context, input }) => {
    const { model_url: url, ...options } = input;
    const optimized = await optimizeGlb(await fetchModel(url, "model_url"), options);

    return {
      model_url: await store(context, optimized.bytes, url, "optimized"),
      stats: optimized.stats,
    };
  }),
};

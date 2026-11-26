import type { JsonValue } from "@repo/contract/json";
import { MEDIA_MODELS } from "@repo/contract/generate/media-schema";
import { ORPCError } from "@orpc/server";

import type { ORPCContext } from "../orpc";
import { os, requireSession } from "../orpc";

type ModelInput = Record<string, JsonValue>;

interface Run {
  endpoint_id: string;
  request_id: string;
  result: JsonValue;
  status: string;
}

type RunModel = (
  context: ORPCContext,
  endpoint: string,
  body: ModelInput,
  wait: number,
) => Promise<Run>;

const bodyOf = (extra: ModelInput, fields: Record<string, JsonValue | undefined>) => {
  const given = Object.entries(fields).filter(
    (entry): entry is [string, JsonValue] => entry[1] !== undefined,
  );

  return { ...extra, ...Object.fromEntries(given) };
};

const authed = os.generate.use(requireSession);

/** One procedure per kind of asset, each running its default model through `runModel`. */
export const mediaRouter = (runModel: RunModel) => ({
  animate3d: authed.animate3d.handler(
    async ({ context, input }) =>
      await runModel(
        context,
        MEDIA_MODELS.animate3d[0],
        bodyOf(input.options, {
          animation_action_ids: input.animation_action_ids,
          height_meters: input.height_meters,
          model_url: input.model_url,
        }),
        input.wait_seconds,
      ),
  ),

  image: authed.image.handler(async ({ context, input }) => {
    const [fromText, edit] = MEDIA_MODELS.image;

    const fields = {
      background: input.background,
      image_size: input.image_size,
      image_urls: input.image_urls,
      num_images: input.num_images,
      prompt: input.prompt,
      quality: input.quality,
    };

    return await runModel(
      context,
      input.image_urls === undefined ? fromText : edit,
      bodyOf(input.options, fields),
      input.wait_seconds,
    );
  }),

  model3d: authed.model3d.handler(async ({ context, input }) => {
    const [fromText, fromImage] = MEDIA_MODELS.model3d;

    if (input.image_url === undefined && input.prompt === undefined) {
      throw new ORPCError("BAD_REQUEST", { message: "Give a prompt or an image_url." });
    }

    const fields = {
      image_url: input.image_url,
      pose_mode: input.pose_mode,
      prompt: input.image_url === undefined ? input.prompt : undefined,
      target_polycount: input.target_polycount,
      topology: input.topology,
    };

    return await runModel(
      context,
      input.image_url === undefined ? fromText : fromImage,
      bodyOf(input.options, fields),
      input.wait_seconds,
    );
  }),

  music: authed.music.handler(
    async ({ context, input }) =>
      await runModel(
        context,
        MEDIA_MODELS.music[0],
        bodyOf(input.options, {
          force_instrumental: input.force_instrumental,
          music_length_ms: input.music_length_ms,
          prompt: input.prompt,
        }),
        input.wait_seconds,
      ),
  ),

  removeBackground: authed.removeBackground.handler(
    async ({ context, input }) =>
      await runModel(
        context,
        MEDIA_MODELS.removeBackground[0],
        bodyOf(input.options, { image_url: input.image_url, prompt: input.prompt }),
        input.wait_seconds,
      ),
  ),

  sound: authed.sound.handler(
    async ({ context, input }) =>
      await runModel(
        context,
        MEDIA_MODELS.sound[0],
        bodyOf(input.options, {
          duration_seconds: input.duration_seconds,
          loop: input.loop,
          text: input.text,
        }),
        input.wait_seconds,
      ),
  ),

  speech: authed.speech.handler(
    async ({ context, input }) =>
      await runModel(
        context,
        MEDIA_MODELS.speech[0],
        bodyOf(input.options, { text: input.text, voice: input.voice }),
        input.wait_seconds,
      ),
  ),

  video: authed.video.handler(async ({ context, input }) => {
    const [fromText, fromImage] = MEDIA_MODELS.video;

    if (input.end_image_url !== undefined && input.image_url === undefined) {
      throw new ORPCError("BAD_REQUEST", { message: "end_image_url needs an image_url." });
    }

    if (input.image_url === undefined && input.prompt === undefined) {
      throw new ORPCError("BAD_REQUEST", { message: "Give a prompt or an image_url." });
    }

    const fields = {
      aspect_ratio: input.aspect_ratio,
      duration: input.duration,
      end_image_url: input.end_image_url,
      generate_audio: input.generate_audio,
      image_url: input.image_url,
      prompt: input.prompt,
      resolution: input.resolution,
    };

    return await runModel(
      context,
      input.image_url === undefined ? fromText : fromImage,
      bodyOf(input.options, fields),
      input.wait_seconds,
    );
  }),
});

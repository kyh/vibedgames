import { z } from "zod";

export const errorRequestSchema = z.object({
  lines: z.array(z.string()),
});
export type ErrorRequestSchema = z.infer<typeof errorRequestSchema>;

export const errorResponseSchema = z.object({
  shouldBeFixed: z.boolean(),
  summary: z.string(),
});
export type ErrorResponseSchema = z.infer<typeof errorResponseSchema>;

export const gameTypesIdToDisplay = {
  multiplayer: "Multiplayer",
  "motion-controlled": "Motion Controlled",
  "3D": "3D",
  "2D": "2D",
  puzzle: "Puzzle",
  platformer: "Platformer",
  racing: "Racing",
  shooting: "Shooting",
  strategy: "Strategy",
  sports: "Sports",
  word: "Word",
  music: "Music",
};

export const gameTypesDisplayToId = Object.fromEntries(
  Object.entries(gameTypesIdToDisplay).map(([id, display]) => [display, id]),
);

export const gameTypesArray = Object.entries(gameTypesIdToDisplay).map(
  ([id, display]) => ({
    id,
    display,
  }),
);

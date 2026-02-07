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

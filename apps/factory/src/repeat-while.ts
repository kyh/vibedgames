/**
 * Calls `step` until it answers `false`, each call after the last has settled:
 * a loop that runs while a condition read inside it holds.
 */
export const repeatWhile = async (step: (round: number) => Promise<boolean>) => {
  const advance: (round: number) => Promise<void> = async (round) => {
    if (await step(round)) {
      await advance(round + 1);
    }
  };

  await advance(0);
};

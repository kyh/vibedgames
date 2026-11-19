export const bestEffort = (run: () => void) => {
  try {
    run();

    return true;
  } catch {
    return false;
  }
};

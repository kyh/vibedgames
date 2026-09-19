/** Preferences are optional; storage denial must never prevent a match. */
export const readPreference = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const savePreference = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The current selection remains usable for this visit.
  }
};

/** Preferences are optional; storage denial must never prevent a match. */
export const readPreference = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const savePreference = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);

    return true;
  } catch {
    return false;
  }
};

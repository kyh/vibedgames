// Element lookups for the ids in index.html. A missing id is a build error,
// not a silent no-op, so every lookup throws instead of returning null.

/** Look an element up by id; throws when index.html does not have it. */
export const mustGet = (id: string): HTMLElement => {
  const el = document.querySelector(`#${id}`);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`missing HUD element #${id}`);
  }
  return el;
};

/** {@link mustGet} for form controls, so `.checked` / `.value` type-check. */
export const mustGetInput = (id: string): HTMLInputElement => {
  const el = mustGet(id);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an <input>`);
  }
  return el;
};

/** Look an element up by id; throws when index.html does not have it. */
export const mustGet = (id: string) => {
  const el = document.querySelector(`#${id}`);

  if (!(el instanceof HTMLElement)) {
    throw new TypeError(`missing HUD element #${id}`);
  }

  return el;
};

/** {@link mustGet} for form controls, so `.checked` / `.value` type-check. */
export const mustGetInput = (id: string) => {
  const el = mustGet(id);

  if (!(el instanceof HTMLInputElement)) {
    throw new TypeError(`#${id} is not an <input>`);
  }

  return el;
};

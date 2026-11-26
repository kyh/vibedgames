/** Ends an exhaustive switch: a case added to the union fails to compile where this is called. */
export const unreachable = (value: never) => {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
};

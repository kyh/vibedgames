/** Resolves once a `setTimeout` of `ms` has fired. */
export const delay = async (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<number>();
  setTimeout(() => {
    resolve(ms);
  }, ms);

  return await promise;
};

/** Resolves on the next animation frame, with that frame's timestamp. */
export const nextFrame = async () => {
  const { promise, resolve } = Promise.withResolvers<number>();
  requestAnimationFrame(resolve);

  return await promise;
};

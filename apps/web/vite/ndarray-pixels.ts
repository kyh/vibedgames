const unsupported = () => {
  throw new Error(
    "Texture pixels are not decoded in the Worker; resize or compress textures with the texture-compress recipe.",
  );
};

export const getPixels = unsupported;

export const savePixels = unsupported;

import { init } from "@dimforge/rapier3d-compat";

export * from "@dimforge/rapier3d-compat";

export const ready = async () => {
  await init();
};

// `#rapier` under Node (package.json "imports", node condition — vite-node's
// SSR resolve): the compat build inlines its wasm, so the sim tools run
// without a wasm loader. Same version and API as the browser build.
import { init } from "@dimforge/rapier3d-compat";

export * from "@dimforge/rapier3d-compat";

export const ready = (): Promise<void> => init();

// `#rapier` in the browser (package.json "imports", default condition): the
// raw-wasm build. vite-plugin-wasm turns its wasm import into a streamed
// fetch, so the 2 MB module is a cacheable asset the browser compiles off the
// main thread instead of a base64 string parsed inside the JS bundle. It is
// instantiated at import, so there is nothing to await.
export * from "@dimforge/rapier3d";

export const ready = (): Promise<void> => Promise.resolve();

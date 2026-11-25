import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";

const GLUE = /[\\/]meshoptimizer[\\/]meshopt_(?<name>decoder|encoder|simplifier)\.m?js$/u;

const INSTANTIATE = /WebAssembly\.instantiate\((?:unpack\(wasm\)|wasm), \{\}\)/u;

const captureWasm = async (file: string) => {
  const real = WebAssembly.instantiate;
  const chunks: Uint8Array[] = [];

  const capture = (source: BufferSource, imports?: WebAssembly.Imports) => {
    chunks.push(new Uint8Array(ArrayBuffer.isView(source) ? source.buffer : source).slice());

    return real(source, imports);
  };

  Object.assign(WebAssembly, { instantiate: capture });

  try {
    await import(`${pathToFileURL(file).href}?capture=${Date.now()}`);
  } finally {
    Object.assign(WebAssembly, { instantiate: real });
  }

  const [bytes] = chunks;

  if (!bytes) {
    throw new Error(`meshopt-wasm: ${file} compiled no WebAssembly`);
  }

  return bytes;
};

/**
 * Workers refuse to compile WebAssembly from bytes at runtime, which is how
 * meshoptimizer's glue loads its embedded module. This compiles each one at
 * build time instead: the module is captured from the glue, written beside
 * the build, and imported as a `.wasm?module` the Worker loads precompiled.
 */
export const meshoptWasm: () => Plugin = () => {
  let cacheDir = "";

  return {
    configEnvironment: (name) =>
      name === "client" ? null : { optimizeDeps: { exclude: ["meshoptimizer"] } },
    configResolved: (config) => {
      cacheDir = path.join(config.cacheDir, "meshopt-wasm");
    },
    enforce: "pre",
    name: "vibedgames:meshopt-wasm",
    transform: async (code, id) => {
      const name = GLUE.exec(id.split("?")[0] ?? "")?.groups?.name;

      if (!name || !INSTANTIATE.test(code)) {
        return null;
      }

      const file = path.join(cacheDir, `${name}.wasm`);
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, await captureWasm(id.split("?")[0] ?? id));

      const precompiled = code.replace(
        INSTANTIATE,
        "WebAssembly.instantiate(__meshoptModule, {}).then(function (instance) { return { instance: instance }; })",
      );

      return {
        code: `import __meshoptModule from ${JSON.stringify(`${file}?module`)};\n${precompiled}`,
        map: null,
      };
    },
  };
};

// Minimal ambient types for tiged (no @types package exists).
// Covers only the surface vg new uses.
declare module "tiged" {
  interface TigedOptions {
    force?: boolean;
    verbose?: boolean;
    mode?: "tar" | "git";
    cache?: boolean;
    "disable-cache"?: boolean;
    "offline-mode"?: boolean;
    subgroup?: boolean;
    "sub-directory"?: string;
  }

  interface TigedEmitter {
    clone(target: string): Promise<void>;
    on(event: string, listener: (info: unknown) => void): TigedEmitter;
  }

  function tiged(src: string, opts?: TigedOptions): TigedEmitter;

  export default tiged;
}

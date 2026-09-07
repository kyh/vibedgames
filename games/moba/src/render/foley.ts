/** Optional accents only. The existing mixer owns every playback source and its
 * budget; a missing/loading sample always leaves the immediate synth fallback. */
export type FoleyKey = "buckler" | "blade" | "bowstring" | "fire" | "mechanism" | "potion";

const FILES = {
  buckler: "audio/foley/buckler.ogg",
  blade: "audio/foley/blade.ogg",
  bowstring: "audio/foley/bowstring.ogg",
  fire: "audio/foley/fire.ogg",
  mechanism: "audio/foley/mechanism.ogg",
  potion: "audio/foley/potion.ogg",
} satisfies Record<FoleyKey, string>;
const KEYS: readonly FoleyKey[] = ["buckler", "blade", "bowstring", "fire", "mechanism", "potion"];
type Entry =
  | { kind: "fetching" | "decoding" | "http-error" | "fetch-error" | "decode-error" }
  | { kind: "ready"; buffer: AudioBuffer };
type LoadStatus = Entry["kind"] | "idle" | "disposed";
type Primed = {
  kind: "primed";
  context: AudioContext;
  abort: AbortController;
  entries: Map<FoleyKey, Entry>;
};
type State = { kind: "idle" } | Primed | { kind: "disposed" };

export class FoleyBank {
  private state: State = { kind: "idle" };

  /** Bind once to the mixer's existing context. Repeated calls (including after
   * pause/reset) do not retry, refetch or create another context. */
  prime(context: AudioContext): void {
    if (this.state.kind !== "idle" || context.state === "closed") return;
    const bank: Primed = {
      kind: "primed",
      context,
      abort: new AbortController(),
      entries: new Map(),
    };
    this.state = bank;
    for (const key of KEYS) {
      bank.entries.set(key, { kind: "fetching" });
      void this.load(bank, key);
    }
  }

  buffer(key: FoleyKey): AudioBuffer | null {
    if (this.state.kind !== "primed") return null;
    const entry = this.state.entries.get(key);
    return entry?.kind === "ready" ? entry.buffer : null;
  }

  /** Fetch can abort; browser decoding cannot. Identity checks make a late
   * decode inert and release every already-cached buffer immediately. */
  dispose(): void {
    const previous = this.state;
    if (previous.kind === "disposed") return;
    this.state = { kind: "disposed" };
    if (previous.kind === "primed") {
      previous.abort.abort();
      previous.entries.clear();
    }
  }

  private async load(bank: Primed, key: FoleyKey): Promise<void> {
    let bytes: ArrayBuffer;
    try {
      const response = await fetch(FILES[key], { signal: bank.abort.signal });
      if (this.state !== bank) return;
      if (!response.ok) {
        bank.entries.set(key, { kind: "http-error" });
        return;
      }
      bytes = await response.arrayBuffer();
      if (this.state !== bank) return;
    } catch {
      if (this.state === bank) bank.entries.set(key, { kind: "fetch-error" });
      return;
    }
    bank.entries.set(key, { kind: "decoding" });
    try {
      const buffer = await bank.context.decodeAudioData(bytes);
      if (this.state === bank) bank.entries.set(key, { kind: "ready", buffer });
    } catch {
      if (this.state === bank) bank.entries.set(key, { kind: "decode-error" });
    }
  }

  diagnostics() {
    let ready = 0;
    let pending = 0;
    let failed = 0;
    const state = this.state;
    if (state.kind === "primed") {
      for (const entry of state.entries.values()) {
        if (entry.kind === "ready") ready++;
        else if (entry.kind === "fetching" || entry.kind === "decoding") pending++;
        else failed++;
      }
    }
    const status: "idle" | "loading" | "ready" | "partial" | "failed" | "disposed" =
      state.kind !== "primed"
        ? state.kind
        : pending > 0
          ? "loading"
          : failed === 0
            ? "ready"
            : ready > 0
              ? "partial"
              : "failed";
    const entryStatus = (key: FoleyKey): LoadStatus =>
      state.kind === "primed" ? (state.entries.get(key)?.kind ?? "idle") : state.kind;
    return Object.freeze({
      status,
      ready,
      pending,
      failed,
      // No optional accent is available yet; callers keep their synth fallback.
      blocked: ready === 0,
      entries: Object.freeze({
        buckler: entryStatus("buckler"),
        blade: entryStatus("blade"),
        bowstring: entryStatus("bowstring"),
        fire: entryStatus("fire"),
        mechanism: entryStatus("mechanism"),
        potion: entryStatus("potion"),
      }),
    });
  }
}

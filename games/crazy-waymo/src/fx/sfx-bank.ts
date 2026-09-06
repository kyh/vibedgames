/** Original generated clips. Paths are relative to Vite's base for hosted games. */
export const SOUND_FILES = {
  "engine-loop": "engine-loop.ogg",
  "road-loop": "road-loop.ogg",
  "drift-loop": "drift-loop.ogg",
  "boost-loop": "boost-loop.ogg",
  "scrape-loop": "scrape-loop.ogg",
  "water-loop": "water-loop.ogg",
  boost: "boost.ogg",
  "impact-soft": "impact-soft.ogg",
  "impact-hard": "impact-hard.ogg",
  landing: "landing.ogg",
  splash: "splash.ogg",
  horn: "horn.ogg",
  "near-miss": "near-miss.ogg",
  "drift-ready": "drift-ready.ogg",
  pickup: "pickup.ogg",
  dropoff: "dropoff.ogg",
  countdown: "countdown.ogg",
  go: "go.ogg",
  warning: "warning.ogg",
  "fare-lost": "fare-lost.ogg",
  finish: "finish.ogg",
  record: "record.ogg",
  denied: "denied.ogg",
  "ui-move": "ui-move.ogg",
  "ui-select": "ui-select.ogg",
  "ui-back": "ui-back.ogg",
  reset: "reset.ogg",
  jump: "jump.ogg",
  "boost-ready": "boost-ready.ogg",
  "ambient-gulls": "ambient-gulls.ogg",
  "ambient-bell": "ambient-bell.ogg",
  "ambient-foghorn": "ambient-foghorn.ogg",
};

export type SoundName = keyof typeof SOUND_FILES;

export class SoundBank {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly failed = new Set<string>();
  private loading: Promise<void> | null = null;

  load(ctx: AudioContext, onDecoded: () => void): Promise<void> {
    this.loading ??= Promise.all(
      Object.entries(SOUND_FILES).map(async ([name, file]) => {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}audio/cozy/${file}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          this.buffers.set(name, await ctx.decodeAudioData(await response.arrayBuffer()));
          onDecoded();
        } catch {
          // No deferred one-shots: a missed cue stays a soft procedural cue.
          this.failed.add(name);
        }
      }),
    ).then(() => undefined);
    return this.loading;
  }

  get(name: SoundName): AudioBuffer | undefined {
    return this.buffers.get(name);
  }

  diagnostics() {
    return {
      loaded: this.buffers.size,
      total: Object.keys(SOUND_FILES).length,
      failed: [...this.failed],
    };
  }
}

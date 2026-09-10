/** Original generated clips. Paths are relative to Vite's base for hosted games. */
export const SOUND_FILES = {
  "ambient-bell": "ambient-bell.ogg",
  "ambient-foghorn": "ambient-foghorn.ogg",
  "ambient-gulls": "ambient-gulls.ogg",
  boost: "boost.ogg",
  "boost-loop": "boost-loop.ogg",
  "boost-ready": "boost-ready.ogg",
  countdown: "countdown.ogg",
  denied: "denied.ogg",
  "drift-loop": "drift-loop.ogg",
  "drift-ready": "drift-ready.ogg",
  dropoff: "dropoff.ogg",
  "engine-loop": "engine-loop.ogg",
  "fare-lost": "fare-lost.ogg",
  finish: "finish.ogg",
  go: "go.ogg",
  horn: "horn.ogg",
  "impact-hard": "impact-hard.ogg",
  "impact-soft": "impact-soft.ogg",
  jump: "jump.ogg",
  landing: "landing.ogg",
  "near-miss": "near-miss.ogg",
  pickup: "pickup.ogg",
  record: "record.ogg",
  reset: "reset.ogg",
  "road-loop": "road-loop.ogg",
  "scrape-loop": "scrape-loop.ogg",
  splash: "splash.ogg",
  "ui-back": "ui-back.ogg",
  "ui-move": "ui-move.ogg",
  "ui-select": "ui-select.ogg",
  warning: "warning.ogg",
  "water-loop": "water-loop.ogg",
};

export type SoundName = keyof typeof SOUND_FILES;

export class SoundBank {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly failed = new Set<string>();
  private loading: Promise<void> | null = null;

  load(ctx: AudioContext, onDecoded: () => void): Promise<void> {
    this.loading ??= this.decodeAll(ctx, onDecoded);
    return this.loading;
  }

  private async decodeAll(ctx: AudioContext, onDecoded: () => void): Promise<void> {
    await Promise.all(
      Object.entries(SOUND_FILES).map(async ([name, file]) => {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}audio/cozy/${file}`);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          this.buffers.set(name, await ctx.decodeAudioData(await response.arrayBuffer()));
          onDecoded();
        } catch {
          // No deferred one-shots: a missed cue stays a soft procedural cue.
          this.failed.add(name);
        }
      }),
    );
  }

  get(name: SoundName): AudioBuffer | undefined {
    return this.buffers.get(name);
  }

  diagnostics() {
    return {
      failed: [...this.failed],
      loaded: this.buffers.size,
      total: Object.keys(SOUND_FILES).length,
    };
  }
}

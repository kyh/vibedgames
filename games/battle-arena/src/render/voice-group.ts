import type { VoicePool } from "./audio-voices";

export type VoicePriority = "routine" | "essential";

export class VoiceGroup {
  private readonly sources = new Map<AudioScheduledSourceNode, () => void>();
  private readonly nodes = new Set<AudioNode>();
  private sealed = false;
  private closed = false;

  readonly priority: VoicePriority;
  private readonly pool: VoicePool;

  constructor(priority: VoicePriority, pool: VoicePool) {
    this.priority = priority;
    this.pool = pool;
  }

  get count() {
    return this.sources.size;
  }

  /** Transient helper nodes only — never a shared bus or persistent layer gain. */
  node<T extends AudioNode>(node: T) {
    this.nodes.add(node);

    return node;
  }

  /** Null when the pool refuses the voice; the caller skips that source. */
  source<T extends AudioScheduledSourceNode>(create: () => T) {
    if (this.closed || !this.pool.admit(this)) {
      return null;
    }

    const source = create();

    const onEnded = () => {
      this.release(source);
    };

    this.sources.set(source, onEnded);
    source.addEventListener("ended", onEnded, { once: true });

    return source;
  }

  /** Construction is synchronous; a sealed group closes once its sources end. */
  seal() {
    this.sealed = true;
    this.finish();
  }

  stopAt(time: number) {
    for (const source of this.sources.keys()) {
      source.stop(time);
    }
  }

  cancel() {
    if (this.closed) {
      return;
    }

    this.sealed = true;

    for (const source of this.sources.keys()) {
      this.release(source);
    }

    this.finish();
  }

  private release(source: AudioScheduledSourceNode) {
    const onEnded = this.sources.get(source);

    if (!onEnded) {
      return;
    }

    this.sources.delete(source);
    source.removeEventListener("ended", onEnded);
    source.disconnect();
    this.finish();
  }

  private finish() {
    if (this.closed || !this.sealed || this.sources.size !== 0) {
      return;
    }

    this.closed = true;

    for (const node of this.nodes) {
      node.disconnect();
    }

    this.nodes.clear();
    this.pool.retire(this);
  }
}

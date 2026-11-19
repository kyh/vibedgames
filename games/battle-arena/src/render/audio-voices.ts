// oxlint-disable-next-line max-classes-per-file -- one ownership family: a group and the pool that evicts groups reference each other
export type VoicePriority = "routine" | "essential";

export class VoiceGroup {
  private sources = new Map<AudioScheduledSourceNode, () => void>();
  private nodes = new Set<AudioNode>();
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
    const onEnded = () => this.release(source);
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

export class VoicePool {
  private groups = new Set<VoiceGroup>();

  private readonly limit: number;
  private readonly routineLimit: number;

  constructor(limit: number, routineLimit: number) {
    this.limit = limit;
    this.routineLimit = routineLimit;
  }

  get count() {
    let n = 0;

    for (const group of this.groups) {
      n += group.count;
    }

    return n;
  }

  begin(priority: VoicePriority = "routine") {
    const group = new VoiceGroup(priority, this);
    this.groups.add(group);

    return group;
  }

  /** Routine voices respect both caps; essential voices evict the oldest routine group. */
  admit(group: VoiceGroup) {
    let total = 0;
    let routine = 0;

    for (const other of this.groups) {
      total += other.count;

      if (other.priority === "routine") {
        routine += other.count;
      }
    }

    if (group.priority === "routine") {
      return total < this.limit && routine < this.routineLimit;
    }

    while (total >= this.limit) {
      const oldest = this.oldestRoutine(group);

      if (!oldest) {
        return false;
      }

      total -= oldest.count;
      oldest.cancel();
    }

    return true;
  }

  private oldestRoutine(except: VoiceGroup) {
    for (const group of this.groups) {
      if (group !== except && group.priority === "routine" && group.count > 0) {
        return group;
      }
    }

    return null;
  }

  clear() {
    for (const group of this.groups) {
      group.cancel();
    }
  }

  retire(group: VoiceGroup) {
    this.groups.delete(group);
  }
}

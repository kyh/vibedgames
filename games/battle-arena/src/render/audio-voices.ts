// Battle Arena's audio graph ownership only. Recipes and source timing stay in
// Audio/Music. Reservations include future notes and filter modulation sources.
type Priority = "routine" | "essential";
type OwnedSource = { startsAt: number; onEnded: () => void };

export class VoiceGroup {
  private sources = new Map<AudioScheduledSourceNode, OwnedSource>();
  private nodes = new Set<AudioNode>();
  private sealed = false;
  private closed = false;

  constructor(
    readonly priority: Priority,
    private reserved: number,
    private pool: VoicePool,
  ) {}

  get count(): number {
    return this.sources.size;
  }

  get committed(): number {
    return this.sources.size + this.reserved;
  }

  future(now: number): number {
    let n = 0;
    for (const voice of this.sources.values()) if (voice.startsAt > now) n++;
    return n;
  }

  /** Add only transient nodes, never a shared bus or persistent layer gain. */
  node<T extends AudioNode>(node: T): T {
    this.nodes.add(node);
    return node;
  }

  /** Reserve before constructing a source; a rejected group allocates nothing. */
  source<T extends AudioScheduledSourceNode>(create: () => T, startsAt: number): T | null {
    if (this.closed || this.reserved === 0) return null;
    const source = create();
    this.reserved--;
    const onEnded = (): void => this.release(source, false);
    this.sources.set(source, { startsAt, onEnded });
    source.addEventListener("ended", onEnded, { once: true });
    this.pool.accepted();
    return source;
  }

  /** Construction is synchronous; unused reservations are released at its end. */
  seal(): void {
    this.sealed = true;
    this.reserved = 0;
    this.finish();
  }

  /** Authored music fade tails keep their graph until every source has ended. */
  stopAt(time: number): void {
    for (const source of this.sources.keys()) source.stop(time);
  }

  cancel(): void {
    if (this.closed) return;
    this.sealed = true;
    this.reserved = 0;
    for (const source of this.sources.keys()) this.release(source, true);
    this.finish();
  }

  private release(source: AudioScheduledSourceNode, stopped: boolean): void {
    const voice = this.sources.get(source);
    if (!voice) return;
    this.sources.delete(source);
    source.removeEventListener("ended", voice.onEnded);
    if (stopped) source.stop();
    source.disconnect();
    this.pool.released(stopped);
    this.finish();
  }

  private finish(): void {
    if (this.closed || !this.sealed || this.sources.size !== 0) return;
    this.closed = true;
    for (const node of this.nodes) node.disconnect();
    this.nodes.clear();
    this.pool.retire(this);
  }
}

export class VoicePool {
  private groups = new Set<VoiceGroup>();
  private acceptedSources = 0;
  private droppedSources = 0;
  private stoppedSources = 0;
  private endedSources = 0;
  private peakSources = 0;

  constructor(
    private limit: number,
    private routineLimit: number,
  ) {}

  get count(): number {
    let n = 0;
    for (const group of this.groups) n += group.count;
    return n;
  }

  begin(required: number, priority: Priority = "routine"): VoiceGroup | null {
    let total = 0;
    let routine = 0;
    for (const group of this.groups) {
      total += group.committed;
      if (group.priority === "routine") routine += group.committed;
    }
    if (
      required <= 0 ||
      required > this.limit ||
      (priority === "routine" &&
        (routine + required > this.routineLimit || total + required > this.limit))
    ) {
      this.droppedSources += Math.max(0, required);
      return null;
    }
    while (total + required > this.limit) {
      let oldest: VoiceGroup | undefined;
      for (const group of this.groups) {
        oldest ??= group;
        if (group.priority === "routine") {
          oldest = group;
          break;
        }
      }
      if (!oldest) return null;
      total -= oldest.committed;
      oldest.cancel();
    }
    const group = new VoiceGroup(priority, required, this);
    this.groups.add(group);
    return group;
  }

  clear(): void {
    for (const group of this.groups) group.cancel();
  }

  accepted(): void {
    this.acceptedSources++;
    this.peakSources = Math.max(this.peakSources, this.count);
  }

  released(stopped: boolean): void {
    if (stopped) this.stoppedSources++;
    else this.endedSources++;
  }

  retire(group: VoiceGroup): void {
    this.groups.delete(group);
  }

  diagnostics(now: number) {
    let scheduledSources = 0;
    let routineSources = 0;
    for (const group of this.groups) {
      scheduledSources += group.future(now);
      if (group.priority === "routine") routineSources += group.count;
    }
    return Object.freeze({
      ownedSources: this.count,
      scheduledSources,
      routineSources,
      essentialSources: this.count - routineSources,
      groups: this.groups.size,
      limit: this.limit,
      routineLimit: this.routineLimit,
      acceptedSources: this.acceptedSources,
      droppedSources: this.droppedSources,
      stoppedSources: this.stoppedSources,
      endedSources: this.endedSources,
      peakSources: this.peakSources,
    });
  }
}

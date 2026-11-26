/** Fire-once cue registry, reset per scene replay. */
export class Cues {
  private readonly fired = new Set<string>();
  reset() {
    this.fired.clear();
  }
  at(hit: boolean, id: string, fn: () => void) {
    if (!hit || this.fired.has(id)) {
      return;
    }

    this.fired.add(id);
    fn();
  }
}

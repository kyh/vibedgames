/** Fire-once cue registry, reset per scene replay. */
export class Cues {
  private fired = new Set<string>();
  reset(): void {
    this.fired.clear();
  }
  at(hit: boolean, id: string, fn: () => void): void {
    if (!hit || this.fired.has(id)) {
      return;
    }
    this.fired.add(id);
    fn();
  }
}

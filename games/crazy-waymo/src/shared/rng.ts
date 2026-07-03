// Tiny deterministic PRNG (mulberry32) so the city + fares are reproducible.
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  pick<T>(arr: readonly T[]): T {
    const v = arr[this.int(arr.length)];
    if (v === undefined) throw new Error("Rng.pick on empty array");
    return v;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

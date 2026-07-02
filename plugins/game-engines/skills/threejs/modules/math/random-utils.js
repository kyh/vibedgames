export class RandomGenerator {
  constructor(seed = 42) {
    this.seed(seed);
  }

  seed(seed = 42) {
    this.state = seed >>> 0;
    return this;
  }

  random() {
    this.state += 0x6d2b79f5;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(min, max) {
    return min + (max - min) * this.random();
  }

  randint(min, max) {
    return Math.floor(this.uniform(min, max + 1));
  }

  randrange(start, stop = null, step = 1) {
    if (stop == null) {
      stop = start;
      start = 0;
    }
    const count = Math.ceil((stop - start) / step);
    return start + Math.floor(this.random() * count) * step;
  }

  choice(items) {
    return items[Math.floor(this.random() * items.length)];
  }
}

export const DEFAULT_PRNG = new RandomGenerator(42);

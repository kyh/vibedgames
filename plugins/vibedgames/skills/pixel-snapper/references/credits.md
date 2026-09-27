# Credits and License

Algorithm, parameter defaults, and the reference Rust implementation by **Hugo Duprez**
([@Hugo-Dz](https://github.com/Hugo-Dz), Sprite Fusion) —
<https://github.com/Hugo-Dz/spritefusion-pixel-snapper> (MIT).
`scripts/pixel-snapper.mjs` is a JavaScript port of his `src/main.rs`.

## License (reproduced from upstream — retained as MIT requires)

```
MIT License

Copyright (c) 2025 Hugo Duprez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Differences from the upstream Rust implementation

The port matches the upstream pipeline and `Config` defaults exactly. Known intentional differences:

- **RNG implementation.** Upstream uses Rust's `ChaCha8Rng` with seed 42. The port uses a mulberry32 generator with the same seed, because reproducing NumPy's SeedSequence/PCG64 bit for bit would buy nothing here. Both are deterministic for a given `--seed`, but their bit streams differ, so the initial k-means cluster centers are not byte-identical. This shows up only where the gradient profiles carry no clear pitch — on dense pixel art the recovered grid and output dimensions matched on every image checked; on a low-contrast input where the pitch is ambiguous the two can land on different dimensions, and in that case the tool has failed either way.
- **Stabilization passes.** Upstream includes `stabilize_cuts` / `stabilize_both_axes` / `snap_uniform_cuts` fallback paths used when the walker produces inconsistent spacing. The port implements only the primary `walk` + `sanitize_cuts` path. On well-formed AI pixel-art inputs (the target case for this skill) the fallbacks are rarely triggered. If you encounter an input where the upstream Rust binary handles cleanly but the port produces ragged grids, the missing stabilizers are the most likely cause — port them across or fall back to the upstream binary for that input.
- **Performance.** The port is slower than the Rust release binary on a 1024² input (still a couple of seconds on a modern laptop). For large batches, prefer the upstream binary.

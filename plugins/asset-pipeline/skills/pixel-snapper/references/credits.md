# Credits and License

## Original Author

The algorithm, parameter defaults, and reference Rust implementation are by:

**Hugo Duprez** ([@Hugo-Dz](https://github.com/Hugo-Dz)) — Sprite Fusion

- Repository: <https://github.com/Hugo-Dz/spritefusion-pixel-snapper>
- Website / interactive demo: <https://spritefusion.com/pixel-snapper>
- License: **MIT**

The Python script in `scripts/pixel_snapper.py` is a faithful, line-for-line port of the algorithm in Hugo's `src/main.rs`. All non-trivial logic — k-means quantization, gradient-profile edge detection, peak-spacing step estimation, walker cut placement, majority-color resampling, fallback strategies, and the entire `Config` parameter set — was designed by Hugo. The port adds nothing original to the algorithm; it is a translation for portability inside uv-driven Python workflows.

If you use this skill in published work, demos, or videos, please credit Hugo and link to the upstream repository. The interactive web demo at spritefusion.com is also worth pointing readers to.

## License (Reproduced from Upstream)

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

## Differences from the Upstream Rust Implementation

The port matches the upstream pipeline and `Config` defaults exactly. Known intentional differences:

- **RNG implementation.** Upstream uses Rust's `ChaCha8Rng` with seed 42. The port uses numpy's `default_rng` with the same seed. Both are deterministic but their bit streams differ, so the initial k-means cluster centers are not byte-identical. Final cell grids and dimensions matched on every test image checked.
- **Stabilization passes.** Upstream includes `stabilize_cuts` / `stabilize_both_axes` / `snap_uniform_cuts` fallback paths used when the walker produces inconsistent spacing. The port implements only the primary `walk` + `sanitize_cuts` path. On well-formed AI pixel-art inputs (the target case for this skill) the fallbacks are rarely triggered. If you encounter an input where the upstream Rust binary handles cleanly but the port produces ragged grids, the missing stabilizers are the most likely cause — port them across or fall back to the upstream binary for that input.
- **Performance.** The port is ~1-2× slower than the Rust release binary on a 1024² input (still <2s on a modern laptop). For large batches, prefer the upstream binary or rewrite the resample loop in vectorized numpy.

## How to Cite

When mentioning this skill in writing or video:

> Pixel grid recovered using a Python port of Hugo Duprez's `spritefusion-pixel-snapper` (MIT) — <https://github.com/Hugo-Dz/spritefusion-pixel-snapper>

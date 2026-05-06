# Algorithm Walkthrough

The snapper recovers the true pixel grid from an upscaled/AI-faked pixel-art image in five stages. This file documents the pipeline at the level needed to debug bad outputs or extend the script. All credit for the algorithm design and parameter defaults belongs to Hugo Duprez (see `credits.md`).

## Pipeline at a Glance

```
input PNG (e.g. 1024×1024, RGBA, AA-smudged)
   │
   ▼
┌──────────────────┐
│ 1. quantize      │  k-means on opaque pixels → palette of K colors
└──────────────────┘
   │
   ▼
┌──────────────────┐
│ 2. profile       │  per-axis 1D edge-gradient sums (col_proj, row_proj)
└──────────────────┘
   │
   ▼
┌──────────────────┐
│ 3. step size     │  median spacing of clean peaks → cell pitch (sx, sy)
└──────────────────┘
   │
   ▼
┌──────────────────┐
│ 4. walk + cuts   │  march by step, snap each cut to nearest peak in window
└──────────────────┘
   │
   ▼
┌──────────────────┐
│ 5. resample      │  for each cell, output one pixel = majority quantized color
└──────────────────┘
   │
   ▼
output PNG (e.g. 100×100, snapped, palette-quantized)
```

## Stage 1 — K-means Color Quantization (`quantize`)

- Operates only on opaque pixels (`alpha > 0`).
- Initialization: `k` random pixels picked via numpy `default_rng(seed=42)`. Upstream Rust uses ChaCha8Rng — different bit stream, same idea.
- Iterates up to `max_kmeans_iterations` (15) until cluster centers stop moving (tol 0.5).
- Output is the source image with each opaque pixel replaced by its assigned cluster center color.
- Why this matters: subsequent edge-gradient detection works much better when colors are sharp categories rather than continuous gradients. A pre-quantized image has *sharper* and *more localized* edge peaks at the true cell boundaries.

## Stage 2 — Edge-Gradient Profiles (`compute_profiles`)

For each axis, build a 1D signal that summarizes "how much pixel-boundary energy is at this column/row".

- Convert RGB to luma: `Y = 0.299 R + 0.587 G + 0.114 B`. Transparent pixels are zeroed.
- Column profile `col_proj[x]` = sum over all rows `y` of `|Y(x+1, y) − Y(x−1, y)|` (a horizontal Sobel-ish gradient with kernel `[-1, 0, 1]`).
- Row profile is the symmetric vertical version.
- Result: two 1D arrays where peaks correspond to vertical/horizontal pixel-cell boundaries.

The reduction from 2D to 1D is what makes the algorithm tractable and elegant. Each axis is an independent 1D problem; their solutions intersect to define the 2D grid.

## Stage 3 — Step-Size Estimation (`estimate_step_size`)

How wide is one true pixel cell?

- Find local maxima above `max_value × peak_threshold_multiplier` (0.2).
- Walk through them keeping only those at least `peak_distance_filter` (4) apart — de-duplicates ringing or thick edges.
- Compute consecutive differences.
- **Return the median** of the differences.

Median (not mean) is the key choice: it's robust to a few wildly-spaced peaks coming from noise or the corners of the image.

`resolve_step_sizes` then handles axis disagreement:
- Both detected → if ratio of larger to smaller is more than `max_step_ratio` (1.8), pick the smaller (assume the bigger is a detection error). Otherwise average.
- One detected → use that for both.
- Neither detected → fallback `min(w, h) / fallback_target_segments` (= /64). If you see exactly 64×64 outputs from inputs with no obvious pixel structure, this is the fallback firing.

## Stage 4 — Walk and Cuts (`walk` + `sanitize_cuts`)

Lay grid lines down across each axis.

- Start at position 0. Each step advances by `step_size`, predicting where the next cut should be.
- At each predicted target, search ±`step × walker_search_window_ratio` (0.35), with a floor of `walker_min_search_window` (2).
- If the strongest peak in that window beats `mean × walker_strength_threshold` (0.5), snap the cut there. Otherwise place it at the predicted target.
- Continue until past the image boundary.

Two key behaviors:
- **The walker doesn't force cuts into noisy regions.** If no strong peak is in range, it just uses the predicted position and moves on. This prevents runaway cut placement when the image has occasional clean spans.
- **Snapping prevents cumulative drift.** Without it, after N steps your cuts would be off by N × (true_step − estimated_step). Snapping resets the position to actual edge content each time.

`sanitize_cuts` then ensures the cut list is sorted, deduplicated, starts at 0, ends at `limit`, and is strictly increasing.

## Stage 5 — Resample (`resample`)

For each rectangular cell defined by `(col_cuts[i], col_cuts[i+1])` × `(row_cuts[j], row_cuts[j+1])`:

- Collect the (already-quantized) RGBA values inside the cell.
- Drop transparent pixels.
- If all transparent → output transparent.
- Otherwise → emit **the most common opaque color** as a single output pixel at `(i, j)`.

The output image is `(len(col_cuts) - 1) × (len(row_cuts) - 1)`. That's why your characters might come out as 94×96 or 129×129 — those are the discovered cell counts, not anything you set.

## Where the Algorithm Goes Wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Output is exactly 64×64 | Step-detection failed for both axes; fallback to `min(w,h)/64` | Input may not have a true pixel grid. Try a different `k_colors`, or accept that this isn't the right tool. |
| Output dimensions oddly small (e.g. 5×5 from a 1024² source) | Quantization collapsed too many colors → very few peaks → step estimate is huge | Increase `k_colors` (try 256 or 512) |
| Output dimensions oddly large (close to source size) | k-means kept noise → many peaks → step estimate is tiny | Decrease `k_colors` (try 16 or 32) |
| One axis is squashed vs the other | x and y step estimates disagreed by > `max_step_ratio`; smaller pitch was applied to both | The source may have non-uniform scaling; pre-resize one axis before snapping |
| 1-pixel-thick "ghost" rows or columns in output | Walker snapped a cut into anti-aliasing | Tighten `peak_threshold_multiplier` (in `Config`) |
| Colors look wrong | k-means assigned mixed pixels to the wrong cluster | Try a different `seed`; vary `k_colors` |

## Mental Model

> Quantize → take per-axis edge histograms → median peak spacing gives the cell pitch → walk along each axis snapping cuts to nearby edges → for each grid cell, pick one representative color → emit one output pixel per cell.

The whole algorithm never tries to find pixel boundaries in 2D; it solves two independent 1D problems whose intersections define the final grid. That decoupling is what makes it robust.

import { FrameTimingWindow } from "../src/render/frame-timing-window";
import { FramePacer } from "../src/render/frame-pacer";
import { checkFramePacer } from "./test-frame-pacer.mts";
import { qualityTiers } from "../src/render/perf-governor";
import { FULL_QUALITY } from "../src/render/quality";

type Check = (name: string, condition: boolean, detail?: string) => void;

function pacedWindows(deltas: readonly number[]): number[] {
  const pacer = new FramePacer("60hz");
  const window = new FrameTimingWindow();
  const windows: number[] = [];
  let now = 0;
  pacer.next(now);
  for (const delta of deltas) {
    now += delta;
    const frame = pacer.next(now);
    if (frame.kind !== "advance" || !frame.timing) continue;
    for (let i = 0; i < frame.timing.samples; i++) {
      const measured = window.sample(frame.timing.dt);
      if (measured !== null) windows.push(measured);
    }
  }
  return windows;
}

export function checkFrameTiming(check: Check): void {
  checkFramePacer(check);
  for (const native of [1, 2]) {
    const phone = qualityTiers(native, true);
    const desktop = qualityTiers(native, false);
    check(
      `all phone tiers retain baked sky and 1024 shadows at DPR ${native}`,
      phone.length === 5 && phone.every((tier) => tier.shadow === 1024 && tier.skyBake),
    );
    check(
      `desktop quality features and shadow ladder stay unchanged at DPR ${native}`,
      desktop.length === 5 &&
        desktop.every(
          (tier, i) =>
            tier.shadow === (i >= 3 ? 1024 : 2048) &&
            tier.skyBake === FULL_QUALITY.skyBake &&
            tier.clouds === FULL_QUALITY.clouds &&
            tier.shadowEvery === FULL_QUALITY.shadowEvery &&
            tier.shadowCast === FULL_QUALITY.shadowCast &&
            tier.detailScale === FULL_QUALITY.detailScale,
        ),
    );
    check(
      `phone detail, clouds, cadence and render ratios survive the GPU budget at DPR ${native}`,
      phone.every(
        (tier, i) =>
          tier.ratio === desktop[i]?.ratio &&
          tier.clouds === [2, 1, 1, 1, 0][i] &&
          tier.detailScale === [1, 0.9, 0.78, 0.66, 0.55][i] &&
          tier.shadowEvery === [1, 1, 2, 3, 3][i] &&
          tier.shadowCast === (i !== 4),
      ),
    );
  }
  const elapsed: number[] = [];
  for (const fps of [8, 30, 60, 120]) {
    const window = new FrameTimingWindow();
    let median: number | null = null;
    let frames = 0;
    while (median === null && frames < fps * 4) {
      median = window.sample(1 / fps);
      frames++;
    }
    elapsed.push(frames / fps);
    check(
      `quality sampling responds at ${fps} FPS within one wall-clock window`,
      median !== null && Math.abs(median - 1000 / fps) < 0.001 && frames / fps <= 2.14,
      `${frames} frames, ${(frames / fps).toFixed(3)}s`,
    );
  }
  check(
    "quality sampling duration stays stable across refresh rates",
    Math.max(...elapsed) - Math.min(...elapsed) < 0.14,
  );
  const hitch = new FrameTimingWindow();
  hitch.sample(8); // resumed tab or isolated long shader compile
  let median: number | null = null;
  for (let i = 0; i < 120 && median === null; i++) median = hitch.sample(1 / 60);
  check("one long hitch does not classify steady 60 FPS as slow", median !== null && median < 17);
  const invalid = new FrameTimingWindow();
  check(
    "invalid timing samples cannot poison the quality window",
    [NaN, Infinity, -1, 0].every((dt) => invalid.sample(dt) === null),
  );
  // A reset must discard previous slow history, as it does while the tab is hidden.
  const afterReset = new FrameTimingWindow();
  for (let i = 0; i < 8; i++) afterReset.sample(1 / 8);
  afterReset.reset();
  let resetMedian: number | null = null;
  for (let i = 0; i < 122 && resetMedian === null; i++) resetMedian = afterReset.sample(1 / 60);
  check("hidden-tab reset discards stale slow samples", resetMedian !== null && resetMedian < 17);

  // One missed refresh every fifth draw is recurrent pacing pressure, not an
  // isolated compile/GC outlier. Pair through the real phone scheduler first.
  for (const spike of [1000 / 30, 50, 100]) {
    const windows = pacedWindows(
      Array.from({ length: 900 }, (_, i) => (i % 5 === 4 ? spike : 1000 / 60)),
    );
    check(
      `recurring ${spike.toFixed(1)} ms phone frames cannot earn quality upgrades`,
      windows.length >= 3 && windows.every((ms) => ms >= 17),
      `${(5000 / (4000 / 60 + spike)).toFixed(1)} FPS; window ${windows[0]?.toFixed(2)} ms`,
    );
    if (spike >= 50)
      check(
        `recurring ${spike} ms phone frames trigger the slow quality threshold`,
        windows.length >= 3 && windows.every((ms) => ms > 21),
      );
  }
  const pairedHitch = pacedWindows([250, ...Array.from({ length: 150 }, () => 1000 / 60)]);
  check(
    "one isolated hitch remains an outlier after phone sample pairing",
    pairedHitch.length > 0 && pairedHitch.every((ms) => ms < 17),
  );
}

if (process.argv.includes("--check")) {
  let failures = 0;
  checkFrameTiming((name, condition, detail) => {
    console.log(`${condition ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
    if (!condition) failures++;
  });
  if (failures > 0) process.exitCode = 1;
}

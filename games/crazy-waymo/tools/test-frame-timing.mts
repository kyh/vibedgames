import { FrameTimingWindow } from "../src/render/frame-timing-window";

type Check = (name: string, condition: boolean, detail?: string) => void;

export function checkFrameTiming(check: Check): void {
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
}

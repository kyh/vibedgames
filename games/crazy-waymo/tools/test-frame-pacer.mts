import { FramePacer } from "../src/render/frame-pacer";
import { FrameTimingWindow } from "../src/render/frame-timing-window";

type Check = (name: string, condition: boolean, detail?: string) => void;

function sample(cadence: "display" | "60hz", times: readonly number[]) {
  const pacer = new FramePacer(cadence);
  const timing = new FrameTimingWindow();
  let updates = 0;
  let elapsed = 0;
  let sampled = 0;
  const intervalsMs: number[] = [];
  const medians: { ms: number; at: number }[] = [];
  for (const time of times) {
    const frame = pacer.next(time);
    if (frame.kind !== "advance" || frame.dt === 0) continue;
    updates++;
    intervalsMs.push(frame.dt * 1000);
    elapsed += frame.dt;
    if (!frame.timing) continue;
    for (let i = 0; i < frame.timing.samples; i++) {
      sampled += frame.timing.dt;
      const median = timing.sample(frame.timing.dt);
      if (median !== null) medians.push({ ms: median, at: time / 1000 });
    }
  }
  return { updates, elapsed, sampled, medians, intervalsMs };
}

export function checkFramePacer(check: Check): void {
  // Browser timestamps may be rounded to tenths of a millisecond. Check the
  // interval distribution too: a 120 Hz source can average 60 draws while
  // alternating 8/25 ms, and a rounded 60 Hz source can lose entire frames.
  for (const hz of [60, 90, 120]) {
    for (const jitter of [false, true]) {
      const times = Array.from({ length: hz * 10 + 1 }, (_, i) => {
        const offset = jitter ? ([0, 0.15, -0.15, 0.08, -0.08][i % 5] ?? 0) : 0;
        return Math.round((1234.567 + (i * 1000) / hz + offset) * 10) / 10;
      });
      const run = sample("60hz", times);
      const min = Math.min(...run.intervalsMs);
      const max = Math.max(...run.intervalsMs);
      check(
        `rounded ${hz} Hz${jitter ? " with jitter" : ""} avoids unnecessary skipped or bunched frames`,
        run.updates === 600 &&
          Math.abs(run.elapsed - 10) < 1e-8 &&
          min >= (hz === 90 ? 10.5 : 16) &&
          max <= (hz === 90 ? 22.7 : 17.4),
        `${run.updates} updates, ${min.toFixed(2)}–${max.toFixed(2)} ms`,
      );
    }
  }
  for (const hz of [60, 90, 120]) {
    const times = Array.from({ length: hz * 60 + 1 }, (_, i) => (i * 1000) / hz);
    const run = sample("60hz", times);
    check(
      `${hz} Hz phone callbacks produce 60 updates per second without clock drift`,
      run.updates === 3600 && Math.abs(run.elapsed - 60) < 1e-8,
      `${run.updates} updates / ${run.elapsed.toFixed(3)} s`,
    );
    check(
      `${hz} Hz pacing preserves governor wall time and does not falsely downgrade`,
      Math.abs(run.sampled - run.elapsed) < 1e-8 &&
        run.medians.length >= 29 &&
        run.medians.every((m) => m.ms < 17) &&
        (run.medians[0]?.at ?? Infinity) < 2.05,
    );
  }

  const fastTimes = Array.from({ length: 121 }, (_, i) => (i * 1000) / 120);
  check(
    "desktop preserves 120 Hz cadence while phone halves its rendered work",
    sample("display", fastTimes).updates === 120 && sample("60hz", fastTimes).updates === 60,
  );

  const variableTimes = [0];
  let time = 0;
  for (let i = 0; i < 7200; i++) {
    time += 1000 / ([90, 120, 144, 60][Math.floor(i / 180) % 4] ?? 60);
    variableTimes.push(time);
  }
  const variable = sample("60hz", variableTimes);
  check(
    "variable refresh stays on the 60 Hz deadline grid without simulation drift",
    Math.abs(variable.updates - (time * 60) / 1000) <= 1 &&
      Math.abs(variable.elapsed - time / 1000) < 1 / 60 &&
      Math.abs(variable.sampled - variable.elapsed) < 1 / 30,
  );

  const slow = sample(
    "60hz",
    Array.from({ length: 121 }, (_, i) => (i * 1000) / 30),
  );
  check(
    "sustained 30 FPS remains slow within the governor's two-second window",
    (slow.medians[0]?.ms ?? 0) > 32 && (slow.medians[0]?.at ?? Infinity) < 2.1,
  );

  const pacer = new FramePacer("60hz");
  pacer.next(0);
  pacer.next(1000 / 60); // half of an unfinished governor pair
  pacer.setPaused(true);
  check(
    "pause draws once then skips updates and performance samples",
    pacer.next(20).kind === "draw" && pacer.next(40).kind === "skip",
  );
  pacer.invalidate();
  check(
    "paused resize requests exactly one fresh draw",
    pacer.next(50).kind === "draw" && pacer.next(60).kind === "skip",
  );
  pacer.setPaused(false);
  const resumed = pacer.next(10000);
  const resumedFirst = pacer.next(10000 + 1000 / 60);
  check(
    "resume drops suspended time and an incomplete governor pair",
    resumed.kind === "advance" &&
      resumed.dt === 0 &&
      resumed.timing === null &&
      resumedFirst.kind === "advance" &&
      resumedFirst.timing === null &&
      Math.abs(resumedFirst.dt - 1 / 60) < 1e-8,
  );
  pacer.setHidden(true);
  pacer.invalidate();
  check("hidden resize never renders or advances gameplay", pacer.next(20000).kind === "skip");
  pacer.setPaused(true);
  pacer.setHidden(false);
  check(
    "visible paused page redraws once without resuming gameplay",
    pacer.next(30000).kind === "draw" && pacer.next(30020).kind === "skip",
  );
  pacer.setPaused(false);
  const visible = pacer.next(40000);
  check(
    "visibility resume never catches up background time",
    visible.kind === "advance" && visible.dt === 0 && visible.timing === null,
  );

  const stall = new FramePacer("60hz");
  stall.next(0);
  const afterStall = stall.next(500);
  check(
    "long frames retain actual elapsed time for the existing simulation clamp without catch-up draws",
    afterStall.kind === "advance" &&
      afterStall.dt === 0.5 &&
      stall.next(500).kind === "skip" &&
      stall.next(505).kind === "skip" &&
      stall.next(1000 / 60 + 500).kind === "advance",
  );
  check(
    "invalid callback timestamps cannot poison the clock",
    [NaN, Infinity, -1].every((t) => stall.next(t).kind === "skip"),
  );
}

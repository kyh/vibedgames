// FX frame-cost harness.
//
// Measures what the spell FX actually cost, by sampling frame intervals with
// the compositor's frame-rate cap removed (--disable-gpu-vsync +
// --disable-frame-rate-limit). With vsync ON every frame reads 16.6ms whether
// it took 2ms or 15ms, so the only thing a capped measurement can tell you is
// whether you already blew the budget — useless for headroom.
//
// Two samples per ability: the scene IDLE, and the scene with that ability
// looping. The difference is the FX cost. Idle is re-measured per ability
// rather than once, so drift in thermal state shows up in both halves.
//
//   node tools/fx-perf.mjs [--throttle N]
import { chromium } from "playwright-core";

const URL = process.env.VG_URL ?? "http://localhost:5194/?viewer=1";
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const THROTTLE = arg("--throttle", 1);
// These materials are fragment-heavy (simplex noise per pixel), and CPU
// throttling does not touch that. Scaling the viewport does: 4x the pixels is
// roughly 4x the fragment work, which is the honest proxy for a weaker GPU
// short of running it on the actual device.
const SCALE = arg("--scale", 1);
const W = Math.round(1600 * SCALE);
const H = Math.round(900 * SCALE);

const CASES = [
  { name: "frost-nova", champ: "V-yx", ability: "Frost Nova" },
  { name: "meteor", champ: "V-yx", ability: "Meteor" },
  { name: "smite", champ: "Aurelius", ability: "Consecrating Smite" },
  { name: "bog-grasp", champ: "Grimelda", ability: "Bog Grasp" },
  { name: "whirlwind", champ: "Garran", ability: "Whirlwind" },
];

const SAMPLE_MS = 4000;

const PAGE_HELPERS = () => {
  const w = /** @type {any} */ (window);
  w.__pick = (t) => {
    const el = [...document.querySelectorAll("*")].find(
      (e) => e.children.length === 0 && (e.textContent || "").trim().startsWith(t),
    );
    if (el) (el.closest("button") || el.parentElement || el).click();
    return !!el;
  };
  /** Sample raw frame intervals for `ms`, then report the distribution. */
  w.__sample = (ms) =>
    new Promise((resolve) => {
      const gaps = [];
      let last = performance.now();
      const stop = last + ms;
      const tick = () => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        if (now < stop) requestAnimationFrame(tick);
        else {
          // Drop the first few: the ability click and the shader compile it may
          // trigger both land there, and a one-off compile stall is not a
          // per-frame cost.
          const s = gaps.slice(5).toSorted((a, b) => a - b);
          const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
          resolve({ frames: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] ?? 0 });
        }
      };
      requestAnimationFrame(tick);
    });
};

const fmt = (n) => n.toFixed(2).padStart(6);

const main = async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    args: ["--disable-gpu-vsync", "--disable-frame-rate-limit"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const cdp = await page.context().newCDPSession(page);
  if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("!!window.__view", null, { timeout: 60_000 });
  await page.waitForTimeout(6000);
  await page.evaluate(PAGE_HELPERS);

  console.log(`viewport ${W}x${H} · cpu throttle ${THROTTLE}x · vsync off\n`);
  console.log("ability          idle p50   fx p50   fx p95  warm max     Δp50   cold max");
  const rows = [];
  for (const c of CASES) {
    await page.evaluate((champ) => /** @type {any} */ (window).__pick(champ), c.champ);
    await page.waitForTimeout(1200);
    const idle = await page.evaluate((ms) => /** @type {any} */ (window).__sample(ms), SAMPLE_MS);

    await page.evaluate((ability) => /** @type {any} */ (window).__pick(ability), c.ability);
    await page.waitForTimeout(1500); // let the first cast compile its shaders
    const first = await page.evaluate((ms) => /** @type {any} */ (window).__sample(ms), SAMPLE_MS);
    // Second pass on the SAME ability: every shader it needs is compiled by
    // now, so a spike that survives here is a real per-cast cost and one that
    // vanishes was a compile stall.
    const fx = await page.evaluate((ms) => /** @type {any} */ (window).__sample(ms), SAMPLE_MS);
    await page.evaluate((ability) => /** @type {any} */ (window).__pick(ability), c.ability); // deselect

    const delta = fx.p50 - idle.p50;
    rows.push({ name: c.name, idle: idle.p50, fx, delta, coldMax: first.max });
    console.log(
      `${c.name.padEnd(16)}${fmt(idle.p50)}   ${fmt(fx.p50)}   ${fmt(fx.p95)}   ${fmt(fx.max)}   ${fmt(delta)}   ${fmt(first.max)}`,
    );
  }
  await browser.close();

  const worst = rows.reduce((a, b) => (b.fx.p95 > a.fx.p95 ? b : a));
  console.log(
    `\nworst p95: ${worst.name} at ${worst.fx.p95.toFixed(2)}ms ` +
      `(${(1000 / worst.fx.p95).toFixed(0)}fps) — budget is 16.6ms`,
  );
  const stalls = rows.filter((r) => r.coldMax > 80 && r.fx.max < r.coldMax / 3);
  if (stalls.length) {
    console.log(
      `COLD-START STALLS (compile on first cast, gone once warm): ` +
        stalls.map((r) => `${r.name} ${r.coldMax.toFixed(0)}ms`).join(", "),
    );
  }
};

main();

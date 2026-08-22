// What is actually blocking on the first cast?
//
// Hooks the WebGL calls that can stall — shader compile, program link, the
// link-status query that blocks until the driver finishes, and texture upload —
// and reports every call over a threshold, with the ability that was on screen.
// Written because three rounds of plausible guesses at a 300ms meteor stall
// were all wrong.
//
//   node tools/fx-stall.mjs [ability]
import { chromium } from "playwright-core";

const URL = process.env.VG_URL ?? "http://localhost:5194/?viewer=1";
const CHAMP = process.argv[2] ?? "V-yx";
const ABILITY = process.argv[3] ?? "Meteor";
const THRESHOLD_MS = Number(process.env.FX_STALL_MS ?? 8);

const HOOK = (thresholdMs) => {
  const w = /** @type {any} */ (window);
  w.__gl = [];
  const protos = [
    typeof WebGL2RenderingContext !== "undefined" ? WebGL2RenderingContext.prototype : null,
    typeof WebGLRenderingContext !== "undefined" ? WebGLRenderingContext.prototype : null,
  ].filter(Boolean);
  const names = [
    "compileShader",
    "linkProgram",
    "getProgramParameter",
    "getShaderParameter",
    "texImage2D",
    "texStorage2D",
    "bufferData",
    "finish",
    "readPixels",
  ];
  for (const proto of protos) {
    for (const name of names) {
      const orig = proto[name];
      if (typeof orig !== "function") continue;
      proto[name] = function (...args) {
        const t0 = performance.now();
        const out = orig.apply(this, args);
        const dt = performance.now() - t0;
        if (dt >= thresholdMs) w.__gl.push({ name, dt: +dt.toFixed(1), at: +t0.toFixed(0) });
        return out;
      };
    }
  }
  w.__pick = (t) => {
    const el = [...document.querySelectorAll("*")].find(
      (e) => e.children.length === 0 && (e.textContent || "").trim().startsWith(t),
    );
    if (el) (el.closest("button") || el.parentElement || el).click();
    return !!el;
  };
};

const main = async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    args: ["--disable-gpu-vsync", "--disable-frame-rate-limit"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript(HOOK, THRESHOLD_MS);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("!!window.__view", null, { timeout: 60_000 });
  await page.waitForTimeout(7000);

  await page.evaluate(() => {
    /** @type {any} */ (window).__gl.length = 0;
  });
  await page.evaluate((c) => /** @type {any} */ (window).__pick(c), CHAMP);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    /** @type {any} */ (window).__gl.length = 0;
  });

  // GL hooks find blocking driver calls; the CPU profile finds everything else.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const scene = w.__view.scene;
    w.__added = [];
    const proto = Object.getPrototypeOf(scene);
    const orig = proto.add;
    proto.add = function (...objs) {
      for (const o of objs) {
        const m = o && o.material;
        if (m) w.__added.push(`${o.type}/${Array.isArray(m) ? "multi" : m.type}`);
        else if (o) w.__added.push(o.type);
      }
      return orig.apply(this, objs);
    };
  });
  const before = await page.evaluate(
    () => /** @type {any} */ (window).__view.renderer.info.programs.map((p) => p.cacheKey ?? ""),
  );
  await page.evaluate((a) => /** @type {any} */ (window).__pick(a), ABILITY);
  await page.waitForTimeout(9000);
  const after = await page.evaluate(
    () => /** @type {any} */ (window).__view.renderer.info.programs.map((p) => p.cacheKey ?? ""),
  );
  const added = await page.evaluate(() => /** @type {any} */ (window).__added);
  const { profile } = await cdp.send("Profiler.stop");
  const hits = await page.evaluate(() => /** @type {any} */ (window).__gl);
  await browser.close();

  const fresh = after.filter((k) => !before.includes(k));
  console.log(
    `${CHAMP} · ${ABILITY} — programs ${before.length} → ${after.length} (${fresh.length} new on first cast)`,
  );
  for (const k of fresh.slice(0, 10)) console.log(`  + ${k.slice(0, 90)}`);
  const counts = new Map();
  for (const a of added) counts.set(a, (counts.get(a) ?? 0) + 1);
  console.log(`\nobjects added to the scene during the cast:`);
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(3)}x ${k}`);
  console.log("");
  if (!hits.length) {
    console.log("GL: none over threshold — nothing blocking in the driver\n");
  } else {
    const byName = new Map();
    for (const h of hits) {
      const e = byName.get(h.name) ?? { n: 0, total: 0, worst: 0 };
      e.n++;
      e.total += h.dt;
      e.worst = Math.max(e.worst, h.dt);
      byName.set(h.name, e);
    }
    for (const [name, e] of [...byName].sort((a, b) => b[1].total - a[1].total)) {
      console.log(
        `${name.padEnd(22)} n=${String(e.n).padStart(3)}  total=${e.total.toFixed(0)}ms  worst=${e.worst.toFixed(0)}ms`,
      );
    }
    console.log("");
  }

  // Self time per node, from the sample counts.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const total = profile.endTime - profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    const n = byId.get(profile.samples[i]);
    if (!n) continue;
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"} — ${(f.url || "").split("/").pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  console.log(`CPU profile over ${(total / 1000).toFixed(0)}ms — top self time:`);
  for (const [key, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${ms.toFixed(0).padStart(6)}ms  ${key}`);
  }
};

main();

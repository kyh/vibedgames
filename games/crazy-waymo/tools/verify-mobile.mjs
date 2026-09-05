// Real touch input and the coarse-pointer render path in a headed browser.
// Usage: node tools/verify-mobile.mjs [dev-url] [output-directory]
// CDP emulation stays attached for the entire run; disconnecting between
// commands resets pointer emulation and silently tests the desktop renderer.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createMobileSession } from "./mobile-browser-session.mjs";

const url = process.argv[2] ?? "http://localhost:5193/?time=night&offline=1";
const output = path.resolve(process.argv[3] ?? "/private/tmp/waymo-mobile-review");
const { call, evaluate, sleep, until, tap, touchPoint, screenshot, close, pageErrors } =
  await createMobileSession({ sessionPrefix: "crazy-waymo-mobile-review", output });
const report = { url, checkedAt: new Date().toISOString(), checks: [], views: [] };
function check(name, passed, evidence) {
  report.checks.push({ name, passed, evidence });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(evidence)}`);
}
try {
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await call("Page.navigate", { url });
  await until("window.__taxi?.game.isReady === true");
  report.worldRevision = await evaluate(
    'import("/src/world/world-bin.ts").then(module=>module.WORLD_REV)',
  );
  const device = await evaluate(
    '({coarse:matchMedia("(pointer:coarse)").matches,touch:navigator.maxTouchPoints,dpr:devicePixelRatio,width:innerWidth,height:innerHeight})',
  );
  check(
    "actual coarse-pointer path",
    device.coarse && device.touch > 0 && device.dpr === 3,
    device,
  );
  // Use the former button's left-hand area: it overlaps the steering zone.
  const formerCta = await evaluate(
    "(()=>{const r=document.querySelector('#banner-cta').getBoundingClientRect();return {x:r.left+Math.min(12,r.width/4),y:r.top+r.height/2,id:1}})()",
  );
  await tap("#banner-cta");
  await until('window.__taxi.game.mode.kind === "playing"');
  await evaluate(
    "(()=>{const t=window.__taxi;t.teleport(.37,.39);const p=t.probe();t.game.traffic.reset({gx:t.game.city.gridX(p.x),gz:t.game.city.gridZ(p.z)},7)})()",
  );
  const hiddenBanner = await evaluate(
    `(()=>{const cta=document.querySelector('#banner-cta');cta.focus();const hit=document.elementFromPoint(${formerCta.x},${formerCta.y});return {focused:document.activeElement===cta,intercepts:!!hit?.closest('#banner'),hit:hit?.id||hit?.tagName}})()`,
  );
  check(
    "hidden start button cannot take focus or intercept steering",
    !hiddenBanner.focused && !hiddenBanner.intercepts,
    { point: formerCta, ...hiddenBanner },
  );
  const before = await evaluate("window.__taxi.probe()");
  await call("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [formerCta],
  });
  await until("window.__taxi.probe().speed > 12", 10_000);
  const driven = await evaluate("window.__taxi.probe()");
  await call("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ ...formerCta, x: formerCta.x + 35 }],
  });
  await sleep(400);
  const steered = await evaluate("window.__taxi.probe()");
  await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  check(
    "touch accelerates and steers from the former start-button bounds",
    driven.speed > 12 && Math.abs(steered.heading - before.heading) > 0.02,
    { before, driven, steered },
  );
  await evaluate("window.__taxi.teleport(.37,.39)");
  const stick = { x: 100, y: 520, id: 1 };
  await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [stick] });
  await until("window.__taxi.probe().speed > 12", 10_000);
  const boostPoint = await touchPoint("#t-boost", 2);
  await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [stick, boostPoint] });
  await until("window.__taxi.probe().boosting", 2000);
  check("touch nitro boost", true, await evaluate("window.__taxi.probe()"));
  await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [stick] });
  const brakePoint = await touchPoint("#t-brake", 3);
  await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [stick, brakePoint] });
  await call("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ ...stick, x: 145 }, brakePoint],
  });
  await until("window.__taxi.probe().drifting", 2000);
  check("touch brake and steering drift", true, await evaluate("window.__taxi.probe()"));
  await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await evaluate("window.__taxi.teleport(.37,.39)");
  const reverseStart = await evaluate("window.__taxi.probe()");
  await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [brakePoint] });
  await until("window.__taxi.probe().speed > 3", 5000);
  const reversed = await evaluate("window.__taxi.probe()");
  await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const reverseDistance =
    (reversed.x - reverseStart.x) * Math.sin(reverseStart.heading) +
    (reversed.z - reverseStart.z) * Math.cos(reverseStart.heading);
  check("touch pedal reverses from stop", reverseDistance < -0.2, { reverseDistance, reversed });
  await tap('[aria-label="Pause"]');
  await until("window.__taxi.game.paused === true");
  const parked = await evaluate("window.__taxi.probe()");
  await sleep(350);
  const paused = await evaluate("window.__taxi.probe()");
  check("pause holds vehicle", Math.hypot(parked.x - paused.x, parked.z - paused.z) < 0.001, {
    parked,
    paused,
  });
  await tap("#waymo-pause .pcta");
  await until("window.__taxi.game.paused === false");
  await tap('[aria-label="Pause"]');
  await until("window.__taxi.game.paused === true");
  await tap("#waymo-pause .prestart");
  await until('window.__taxi.game.mode.kind === "playing" && !window.__taxi.game.paused');
  check("touch resume and restart", true, await evaluate("window.__taxi.probe()"));
  for (const [name, width, height, u, v, phase] of [
    ["portrait-night", 390, 844, 0.738, 0.19, 0.7],
    ["landscape-night", 844, 390, 0.235, 0.674, 0.7],
    ["landscape-noon", 844, 390, 0.437, 0.401, 0.25],
  ]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await evaluate(`window.__taxi.teleport(${u},${v});window.__taxi.setPhase(${phase})`);
    await sleep(2500);
    await screenshot(name);
    const view = await evaluate(
      '({coarse:matchMedia("(pointer:coarse)").matches,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,stream:window.__taxi.game.city.parcelStreamStats()})',
    );
    report.views.push({ name, ...view });
    check(`${name} fits viewport`, view.coarse && !view.overflow, view);
    if (width < 520) {
      const overlaps = await evaluate(
        '(()=>{const a=document.querySelector("#area").getBoundingClientRect();return [...document.querySelectorAll("#score,[aria-label=Pause],[aria-label^=\\\"Turn sound\\\"]")].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top}).map(e=>e.id||e.getAttribute("aria-label"))})()',
      );
      check("portrait district clears HUD controls", overlaps.length === 0, overlaps);
    }
  }
  check("no mobile page errors", pageErrors.length === 0, pageErrors);
  if (report.checks.some((entry) => !entry.passed)) process.exitCode = 1;
} catch (error) {
  check("mobile run completed", false, String(error));
  await screenshot("failure");
  report.failureState = await evaluate(
    "({mode:window.__taxi?.game.mode.kind,ready:window.__taxi?.game.isReady,text:document.body.innerText})",
  );
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  close();
}

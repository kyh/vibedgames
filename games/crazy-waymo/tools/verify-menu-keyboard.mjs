// Trusted browser touch/keys verify Start activation and game-key isolation.
// Usage: node tools/verify-menu-keyboard.mjs [dev-url] [output-directory]
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createMobileSession } from "./mobile-browser-session.mjs";

const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const output = path.resolve(process.argv[3] ?? "/private/tmp/waymo-menu-keyboard");
const { call, evaluate, until, sleep, screenshot, close, pageErrors } = await createMobileSession({
  sessionPrefix: "crazy-waymo-menu-keyboard",
  output,
});
const report = { url, checkedAt: new Date().toISOString(), checks: [] };
async function key(type, name, code, virtualKey, text) {
  const event = {
    type,
    key: name,
    code,
    windowsVirtualKeyCode: virtualKey,
  };
  if (text !== undefined) event.text = text;
  await call("Input.dispatchKeyEvent", event);
}
function check(name, passed, evidence) {
  const result = { name, passed, evidence };
  report.checks.push(result);
  console.log(JSON.stringify(result));
  if (!passed) throw new Error(name);
}
async function title() {
  await call("Page.navigate", { url });
  await until(
    'window.__taxi?.game.isReady && window.__taxi.game.mode.kind === "title" && !document.querySelector("#banner").inert',
  );
  await until(
    '(()=>{const e=document.querySelector("#banner-cta"),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()',
  );
  await evaluate(`window.__menuClicks=[];window.__menuEvents=[];
    document.querySelector("#banner-cta").addEventListener("click",event=>window.__menuClicks.push({trusted:event.isTrusted,detail:event.detail}));
    for(const type of ["pointerdown","pointerup","pointercancel","click"])document.addEventListener(type,event=>window.__menuEvents.push({type,trusted:event.isTrusted,pointer:event.pointerType,cta:!!event.target.closest("#banner-cta"),mode:window.__taxi.game.mode.kind}));`);
}
const state = () =>
  evaluate(
    '({mode:window.__taxi.game.mode.kind,chatting:document.body.classList.contains("chatting"),events:window.__menuEvents,clicks:window.__menuClicks,active:document.activeElement?.id})',
  );
const touch = (type, point) =>
  call("Input.dispatchTouchEvent", { type, touchPoints: point ? [point] : [] });
try {
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await title();
  const point = await evaluate(
    '(()=>{const r=document.querySelector("#banner-cta").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,id:1}})()',
  );
  await touch("touchStart", point);
  await sleep(100);
  await touch("touchEnd");
  await until('window.__taxi.game.mode.kind === "playing"');
  await sleep(350);
  const firstTap = await state();
  check(
    "first trusted touch starts on release before a compatibility click",
    firstTap.mode === "playing" &&
      !firstTap.chatting &&
      firstTap.events.some(
        (event) =>
          event.type === "pointerup" &&
          event.trusted &&
          event.cta &&
          event.pointer === "touch" &&
          (event.mode === "countdown" || event.mode === "playing"),
      ),
    firstTap,
  );
  await screenshot("start-first-touch");

  await title();
  const cancelPoint = await evaluate(
    '(()=>{const r=document.querySelector("#banner-cta").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,id:1}})()',
  );
  await touch("touchStart", cancelPoint);
  await sleep(100);
  await touch("touchCancel");
  await sleep(150);
  const cancelled = await state();
  check(
    "cancelled trusted touch leaves Start available",
    cancelled.mode === "title" &&
      cancelled.events.some((event) => event.type === "pointercancel" && event.trusted),
    cancelled,
  );
  // Return inside before release: bounds alone must not turn a drag into a tap.
  await touch("touchStart", cancelPoint);
  await touch("touchMove", { ...cancelPoint, x: cancelPoint.x + 35 });
  await sleep(100);
  await touch("touchMove", cancelPoint);
  await touch("touchEnd");
  await sleep(350);
  const dragged = await state();
  check("dragging then returning to Start does not activate it", dragged.mode === "title", dragged);

  for (const [name, code, virtualKey, text] of [
    ["Enter", "Enter", 13, "\r"],
    [" ", "Space", 32, " "],
  ]) {
    // Enter follows rejected touches on the same button, so stale touch-click
    // suppression cannot silently swallow a future keyboard activation.
    if (code === "Space") await title();
    await evaluate("window.__menuClicks=[]");
    // Reach Start through the browser's focus order, without calling its handler.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await evaluate('document.activeElement?.id === "banner-cta"')) break;
      await key("keyDown", "Tab", "Tab", 9);
      await key("keyUp", "Tab", "Tab", 9);
    }
    if (!(await evaluate('document.activeElement?.id === "banner-cta"'))) {
      throw new Error("Start button is unreachable through keyboard focus");
    }
    await key("keyDown", name, code, virtualKey, text);
    await sleep(100);
    await key("keyUp", name, code, virtualKey);
    await until('window.__taxi.game.mode.kind === "playing"');
    // Let the game consume queued key edges: a duplicate Enter opens chat here.
    await sleep(750);
    const evidence = await state();
    const passed =
      evidence.mode === "playing" &&
      !evidence.chatting &&
      evidence.clicks.length === 1 &&
      evidence.clicks[0].trusted;
    check(`${code} activates Start once without opening chat`, passed, evidence);
    await screenshot(`start-${code.toLowerCase()}`);
  }
  report.checks.push({
    name: "No page errors",
    passed: pageErrors.length === 0,
    evidence: pageErrors,
  });
} catch (error) {
  report.failure = String(error);
  try {
    await screenshot("failure");
  } catch {}
} finally {
  report.passed = !report.failure && report.checks.every((check) => check.passed);
  writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  close();
}
if (!report.passed) process.exitCode = 1;

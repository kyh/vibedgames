import { writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { JsonValue } from "../src/shared/json.ts";
import { inOrder } from "../src/shared/paced.ts";
import { createMobileSession, touchPointSchema } from "./mobile-browser-session.mts";
import type { TouchPoint } from "./mobile-browser-session.mts";
import type { CheckEntry } from "./page-shapes.mts";

const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const output = path.resolve(process.argv[3] ?? "/private/tmp/waymo-menu-keyboard");

const { call, evaluate, read, until, sleep, screenshot, close, pageErrors } =
  await createMobileSession({
    output,
    sessionPrefix: "crazy-waymo-menu-keyboard",
  });

interface MenuReport {
  checkedAt: string;
  checks: CheckEntry[];
  url: string;
  failure?: string;
  passed?: boolean;
}

const report: MenuReport = { checkedAt: new Date().toISOString(), checks: [], url };

const key = async (type: string, name: string, code: string, virtualKey: number, text?: string) => {
  const event = { code, key: name, type, windowsVirtualKeyCode: virtualKey };

  await call("Input.dispatchKeyEvent", text === undefined ? event : { ...event, text });
};

const check = (name: string, passed: boolean, evidence: JsonValue) => {
  const result = { evidence, name, passed };
  report.checks.push(result);
  console.log(JSON.stringify(result));

  if (!passed) {
    throw new Error(name);
  }
};

const title = async () => {
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
};

const stateSchema = z.object({
  active: z.string().optional(),
  chatting: z.boolean(),
  clicks: z.array(z.object({ detail: z.number(), trusted: z.boolean() })),
  events: z.array(
    z.object({
      cta: z.boolean(),
      mode: z.string(),
      pointer: z.string().optional(),
      trusted: z.boolean(),
      type: z.string(),
    }),
  ),
  mode: z.string(),
});

const state = async () =>
  await read(
    '({mode:window.__taxi.game.mode.kind,chatting:document.body.classList.contains("chatting"),events:window.__menuEvents,clicks:window.__menuClicks,active:document.activeElement?.id})',
    stateSchema,
  );

const touch = async (type: string, point?: TouchPoint) => {
  await call("Input.dispatchTouchEvent", { touchPoints: point ? [point] : [], type });
};

const focused = async () =>
  (await evaluate('document.activeElement?.id === "banner-cta"')) === true;

const focusStart: (attempt: number) => Promise<void> = async (attempt) => {
  if (attempt >= 20 || (await focused())) {
    return;
  }

  await key("keyDown", "Tab", "Tab", 9);
  await key("keyUp", "Tab", "Tab", 9);
  await focusStart(attempt + 1);
};

const ctaCentre =
  '(()=>{const r=document.querySelector("#banner-cta").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,id:1}})()';

try {
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 3,
    height: 844,
    mobile: true,
    width: 390,
  });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await title();

  const point = await read(ctaCentre, touchPointSchema);

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

  const cancelPoint = await read(ctaCentre, touchPointSchema);

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
  await touch("touchStart", cancelPoint);
  await touch("touchMove", { ...cancelPoint, x: cancelPoint.x + 35 });
  await sleep(100);
  await touch("touchMove", cancelPoint);
  await touch("touchEnd");
  await sleep(350);
  const dragged = await state();
  check("dragging then returning to Start does not activate it", dragged.mode === "title", dragged);

  const keys = [
    ["Enter", "Enter", 13, "\r"],
    [" ", "Space", 32, " "],
  ] as const;

  for await (const [name, code, virtualKey, text] of inOrder(keys)) {
    if (code === "Space") {
      await title();
    }

    await evaluate("window.__menuClicks=[]");

    await focusStart(0);

    if (!(await focused())) {
      throw new Error("Start button is unreachable through keyboard focus");
    }

    await key("keyDown", name, code, virtualKey, text);
    await sleep(100);
    await key("keyUp", name, code, virtualKey);
    await until('window.__taxi.game.mode.kind === "playing"');
    await sleep(750);
    const evidence = await state();

    const passed =
      evidence.mode === "playing" &&
      !evidence.chatting &&
      evidence.clicks.length === 1 &&
      evidence.clicks[0]?.trusted === true;

    check(`${code} activates Start once without opening chat`, passed, evidence);
    await screenshot(`start-${code.toLowerCase()}`);
  }

  report.checks.push({
    evidence: pageErrors,
    name: "No page errors",
    passed: pageErrors.length === 0,
  });
} catch (error) {
  report.failure = String(error);

  await screenshot("failure").catch(() => null);
} finally {
  report.passed = report.failure === undefined && report.checks.every((entry) => entry.passed);
  writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  close();
}

if (!report.passed) {
  process.exitCode = 1;
}

import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { JsonValue } from "../src/shared/json.ts";
import { inOrder, range } from "../src/shared/paced.ts";
import { createMobileSession, touchPointSchema } from "./mobile-browser-session.mts";
import { createChecks, jsonSchema, PROBE, probeSchema } from "./page-shapes.mts";

const url = process.argv[2] ?? "http://localhost:5193/?time=night&offline=1";
const output = path.resolve(process.argv[3] ?? "/private/tmp/waymo-mobile-review");

const {
  call,
  evaluate,
  read,
  pause,
  sleep,
  until,
  tap,
  touchPoint,
  screenshot,
  close,
  pageErrors,
} = await createMobileSession({ output, sessionPrefix: "crazy-waymo-mobile-review" });

interface MobileReport {
  checkedAt: string;
  checks: typeof checks;
  url: string;
  views: JsonValue[];
  worldRevision?: number;
  failureState?: JsonValue;
}

const { check, checks, failed } = createChecks();

const report: MobileReport = { checkedAt: new Date().toISOString(), checks, url, views: [] };

const workSchema = z.object({ draws: z.number(), updates: z.number() });

try {
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 3,
    height: 844,
    mobile: true,
    width: 390,
  });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await call("Page.navigate", { url });
  await until("window.__taxi?.game.isReady === true");
  report.worldRevision = await read(
    'import("/src/world/world-bin.ts").then(module=>module.WORLD_REV)',
    z.number(),
  );

  const device = await read(
    '({coarse:matchMedia("(pointer:coarse)").matches,touch:navigator.maxTouchPoints,dpr:devicePixelRatio,width:innerWidth,height:innerHeight})',
    z.object({
      coarse: z.boolean(),
      dpr: z.number(),
      height: z.number(),
      touch: z.number(),
      width: z.number(),
    }),
  );

  check(
    "actual coarse-pointer path",
    device.coarse && device.touch > 0 && device.dpr === 3,
    device,
  );

  const formerCta = await read(
    "(()=>{const r=document.querySelector('#banner-cta').getBoundingClientRect();return {x:r.left+Math.min(12,r.width/4),y:r.top+r.height/2,id:1}})()",
    touchPointSchema,
  );

  await tap("#banner-cta");
  await until('window.__taxi.game.mode.kind === "playing"');
  await evaluate(
    "(()=>{const t=window.__taxi;t.teleport(.37,.39);const p=t.probe();t.game.traffic.reset({gx:t.game.city.gridX(p.x),gz:t.game.city.gridZ(p.z)},7)})()",
  );

  const hiddenBanner = await read(
    `(()=>{const cta=document.querySelector('#banner-cta');cta.focus();const hit=document.elementFromPoint(${formerCta.x},${formerCta.y});return {focused:document.activeElement===cta,intercepts:!!hit?.closest('#banner'),hit:hit?.id||hit?.tagName}})()`,
    z.object({ focused: z.boolean(), hit: z.string().optional(), intercepts: z.boolean() }),
  );

  check(
    "hidden start button cannot take focus or intercept steering",
    !hiddenBanner.focused && !hiddenBanner.intercepts,
    { point: formerCta, ...hiddenBanner },
  );
  const before = await read(PROBE, probeSchema);
  await call("Input.dispatchTouchEvent", {
    touchPoints: [formerCta],
    type: "touchStart",
  });
  await until("window.__taxi.probe().speed > 12", 10_000);
  const driven = await read(PROBE, probeSchema);
  await call("Input.dispatchTouchEvent", {
    touchPoints: [{ ...formerCta, x: formerCta.x + 35 }],
    type: "touchMove",
  });
  await sleep(400);
  const steered = await read(PROBE, probeSchema);
  await call("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
  check(
    "touch accelerates and steers from the former start-button bounds",
    driven.speed > 12 && Math.abs(steered.heading - before.heading) > 0.02,
    { before, driven, steered },
  );
  await evaluate("window.__taxi.teleport(.37,.39)");
  const stick = { id: 1, x: 100, y: 520 };
  await call("Input.dispatchTouchEvent", { touchPoints: [stick], type: "touchStart" });
  await until("window.__taxi.probe().speed > 12", 10_000);
  const boostPoint = await touchPoint("#t-boost", 2);
  await call("Input.dispatchTouchEvent", { touchPoints: [stick, boostPoint], type: "touchStart" });
  await until("window.__taxi.probe().boosting", 2000);
  check("touch nitro boost", true, await read(PROBE, probeSchema));
  await call("Input.dispatchTouchEvent", { touchPoints: [stick], type: "touchEnd" });
  const brakePoint = await touchPoint("#t-brake", 3);
  await call("Input.dispatchTouchEvent", { touchPoints: [stick, brakePoint], type: "touchStart" });
  await call("Input.dispatchTouchEvent", {
    touchPoints: [{ ...stick, x: 145 }, brakePoint],
    type: "touchMove",
  });
  await until("window.__taxi.probe().drifting", 2000);
  check("touch brake and steering drift", true, await read(PROBE, probeSchema));
  await call("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
  await evaluate("window.__taxi.teleport(.37,.39)");
  const reverseStart = await read(PROBE, probeSchema);
  await call("Input.dispatchTouchEvent", { touchPoints: [brakePoint], type: "touchStart" });
  await until("window.__taxi.probe().speed > 3", 5000);
  const reversed = await read(PROBE, probeSchema);
  await call("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });

  const reverseDistance =
    (reversed.x - reverseStart.x) * Math.sin(reverseStart.heading) +
    (reversed.z - reverseStart.z) * Math.cos(reverseStart.heading);

  check("touch pedal reverses from stop", reverseDistance < -0.2, { reverseDistance, reversed });
  await evaluate(`(()=>{const r=window.__renderer,render=r.render,g=window.__taxi.game,update=g.update;
    window.__phoneWork={draws:0,updates:0};
    r.render=function(...args){if(this.getRenderTarget()===null)window.__phoneWork.draws++;return render.apply(this,args);};
    g.update=function(...args){window.__phoneWork.updates++;return update.apply(this,args);};})()`);
  await pause();
  await until("window.__taxi.game.paused === true");
  await sleep(100);
  const tierWork = workSchema.extend({ tier: z.number() });
  const idleBefore = await read("({...window.__phoneWork,tier:window.__perf.tier()})", tierWork);
  const parked = await read(PROBE, probeSchema);
  await sleep(1500);
  const paused = await read(PROBE, probeSchema);
  check("pause holds vehicle", Math.hypot(parked.x - paused.x, parked.z - paused.z) < 0.001, {
    parked,
    paused,
  });
  const idleAfter = await read("({...window.__phoneWork,tier:window.__perf.tier()})", tierWork);
  check(
    "paused phone stops GPU and simulation work",
    idleAfter.draws === idleBefore.draws &&
      idleAfter.updates === idleBefore.updates &&
      idleAfter.tier === idleBefore.tier,
    { idleAfter, idleBefore },
  );
  await call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 3,
    height: 390,
    mobile: true,
    width: 844,
  });
  await sleep(350);

  const resized = await read(
    "({...window.__phoneWork,width:innerWidth,height:innerHeight})",
    workSchema.extend({ height: z.number(), width: z.number() }),
  );

  check(
    "paused resize redraws once without advancing simulation",
    resized.draws - idleAfter.draws === 1 &&
      resized.updates === idleAfter.updates &&
      resized.width === 844,
    { idleAfter, resized },
  );
  await call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 3,
    height: 844,
    mobile: true,
    width: 390,
  });
  await sleep(350);
  await tap("#waymo-pause .pcta");
  await until("window.__taxi.game.paused === false");
  const timedWork = workSchema.extend({ at: z.number() });
  const activeBefore = await read("({...window.__phoneWork,at:performance.now()})", timedWork);
  await sleep(1500);
  const activeAfter = await read("({...window.__phoneWork,at:performance.now()})", timedWork);

  const drawHz =
    ((activeAfter.draws - activeBefore.draws) * 1000) / (activeAfter.at - activeBefore.at);

  check("resumed phone renders at most 60 Hz", drawHz > 10 && drawHz <= 61, {
    activeAfter,
    activeBefore,
    drawHz,
  });
  await pause();
  await until("window.__taxi.game.paused === true");
  await tap("#waymo-pause .prestart");
  await until('window.__taxi.game.mode.kind === "playing" && !window.__taxi.game.paused');
  check("touch resume and restart", true, await read(PROBE, probeSchema));
  const restartStart = await read(PROBE, probeSchema);
  await call("Input.dispatchTouchEvent", { touchPoints: [stick], type: "touchStart" });
  await until(
    `(()=>{const p=window.__taxi.probe();return p.speed>15&&Math.hypot(p.x-(${restartStart.x}),p.z-(${restartStart.z}))>30})()`,
    8000,
  );

  const restartDrive = await read(
    "(()=>{const t=window.__taxi;return {probe:t.probe(),cameraDistance:t.camera.position.distanceTo(t.game.car.position)}})()",
    z.object({ cameraDistance: z.number(), probe: probeSchema }),
  );

  await call("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
  check(
    "restart gives a drivable route and clear chase camera",
    restartDrive.probe.speed > 15 && restartDrive.cameraDistance > 6,
    { start: restartStart, ...restartDrive },
  );

  const views = [
    ["portrait-night", 390, 844, 0.738, 0.19, 0.7],
    ["landscape-night", 844, 390, 0.235, 0.674, 0.7],
    ["landscape-noon", 844, 390, 0.437, 0.401, 0.25],
  ] as const;

  for await (const [name, width, height, u, v, phase] of inOrder(views)) {
    await call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 3,
      height,
      mobile: true,
      width,
    });
    await evaluate(`window.__taxi.teleport(${u},${v});window.__taxi.setPhase(${phase})`);
    await sleep(2500);
    await screenshot(name);

    const view = await read(
      '({coarse:matchMedia("(pointer:coarse)").matches,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,stream:window.__taxi.game.city.parcelStreamStats()})',
      z.object({
        coarse: z.boolean(),
        height: z.number(),
        overflow: z.boolean(),
        stream: jsonSchema,
        width: z.number(),
      }),
    );

    report.views.push({ name, ...view });
    check(`${name} fits viewport`, view.coarse && !view.overflow, view);

    if (width < 520) {
      const overlaps = await read(
        '(()=>{const a=document.querySelector("#area").getBoundingClientRect();return [...document.querySelectorAll("#score,[aria-label=Pause],[aria-label^=\\\"Turn sound\\\"]")].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top}).map(e=>e.id||e.getAttribute("aria-label"))})()',
        z.array(z.string().nullable()),
      );

      check("portrait district clears HUD controls", overlaps.length === 0, overlaps);
    }
  }

  const tierSchema = z.object({
    ratio: z.number(),
    shadowCast: z.boolean(),
    shadowHeight: z.number(),
    shadowWidth: z.number(),
    skyBake: z.boolean(),
    tier: z.number(),
  });

  const tierBudget: z.infer<typeof tierSchema>[] = [];

  for await (const tier of inOrder(range(5))) {
    await evaluate(`window.__perf.pin(${tier})`);
    await sleep(200);
    tierBudget.push(
      await read(
        "(()=>{const g=window.__taxi.game,s=g.sunLight.shadow;return {tier:window.__perf.tier(),shadowWidth:s.mapSize.x,shadowHeight:s.mapSize.y,skyBake:g.quality.skyBake,shadowCast:g.quality.shadowCast,ratio:window.__renderer.getPixelRatio()}})()",
        tierSchema,
      ),
    );
  }

  check(
    "all phone tiers retain bounded shadows and baked sky",
    tierBudget.every(
      (tier) =>
        tier.shadowWidth === 1024 &&
        tier.shadowHeight === 1024 &&
        tier.skyBake &&
        tier.shadowCast === (tier.tier !== 4),
    ),
    tierBudget,
  );
  await evaluate("window.__perf.pin(null)");
  check("no mobile page errors", pageErrors.length === 0, pageErrors);

  if (failed()) {
    process.exitCode = 1;
  }
} catch (error) {
  check("mobile run completed", false, String(error));
  await screenshot("failure");
  report.failureState = await read(
    "({mode:window.__taxi?.game.mode.kind,ready:window.__taxi?.game.isReady,text:document.body.innerText})",
    jsonSchema,
  );
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  close();
}

// Headed Chrome mobile stress proxy. Not a real-phone benchmark.
// Usage: node tools/verify-mobile-performance.mjs [url] [output] [rates=1,2,4] [ms=8000]
// Options: --transition (first shadowless tier), --production, --ab, --profile.
// CDP emulation stays attached for the entire run; disconnecting between
// commands resets pointer emulation and silently tests the desktop renderer.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createMobileSession } from "./mobile-browser-session.mjs";

const url = process.argv[2] ?? "http://localhost:5193/?time=noon&offline=1";
const output = path.resolve(process.argv[3] ?? "/private/tmp/waymo-mobile-performance");
const report = {
  url,
  checkedAt: new Date().toISOString(),
  environment:
    "Headed desktop Chrome; coarse pointer, DPR 3, CPU throttle stress proxy. Not a physical-phone measurement.",
  runs: [],
};
const rates = (process.argv[4] ?? "1,2,4").split(",").map(Number);
const durationMs = Number(process.argv[5] ?? 8000);
const ab = process.argv.includes("--ab");
const profile = process.argv.includes("--profile");
const production = process.argv.includes("--production");
const transitionProbe = process.argv.includes("--transition");
if (rates.length === 0 || rates.some((rate) => !Number.isFinite(rate) || rate < 1 || rate > 20)) {
  throw new Error("CPU rates must be numbers from 1 to 20");
}
if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 60000) {
  throw new Error("Drive duration must be 1000..60000 ms");
}
if (ab && (rates.length !== 3 || new Set(rates).size !== 1)) {
  throw new Error("A/B requires three identical CPU rates");
}
const { call, evaluate, sleep, until, tap, screenshot, close, pageErrors } =
  await createMobileSession({ sessionPrefix: "crazy-waymo-mobile-performance", output });
const earlyMetrics = `(()=>{if(window.__mobileMetricsInstalled)return;window.__mobileMetricsInstalled=true;window.__mobileMph=0;const fillText=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(...args){const text=String(args[0]).trim(),value=Number(text);if(this.canvas.id==='dash-dial'&&text!==''&&Number.isFinite(value))window.__mobileMph=value;return fillText.apply(this,args);};window.__mobileCold={installedAt:performance.now(),longTasks:[]};new PerformanceObserver(list=>{for(const e of list.getEntries())window.__mobileCold.longTasks.push({start:e.startTime,duration:e.duration});}).observe({type:'longtask',buffered:true});})()`;
let iteration = 0;
async function productionSmoke(opened) {
  await until("getComputedStyle(document.querySelector('#loading')).display === 'none'");
  report.readyMs = Date.now() - opened;
  await evaluate(earlyMetrics);
  await until("Number.isFinite(window.__mobileMph)");
  report.cold = await evaluate("window.__mobileCold");
  report.device = await evaluate(
    "({coarse:matchMedia('(pointer:coarse)').matches,dpr:devicePixelRatio,touch:navigator.maxTouchPoints,debugHooks:typeof window.__taxi})",
  );
  if (!report.device.coarse || report.device.dpr !== 3 || report.device.debugHooks !== "undefined")
    throw new Error("Expected production coarse DPR3 renderer without development hooks");
  await tap("#banner-cta");
  for (const [name, width, height] of [
    ["portrait", 390, 844],
    ["landscape", 844, 390],
  ]) {
    if (name === "landscape") {
      await tap('[aria-label="Pause"]');
      await tap("#waymo-pause .prestart");
    }
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await call("Emulation.setCPUThrottlingRate", { rate: 2 });
    await sleep(1500);
    await evaluate(
      `(()=>{window.__productionFrames={active:true,frames:[],mph:[]};let previous=0;function frame(t){const m=window.__productionFrames;if(!m.active)return;if(previous)m.frames.push(t-previous);if(Number.isFinite(window.__mobileMph))m.mph.push(window.__mobileMph);previous=t;requestAnimationFrame(frame);}requestAnimationFrame(frame);})()`,
    );
    await call("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: name === "portrait" ? 100 : 250, y: name === "portrait" ? 520 : 200, id: 1 },
      ],
    });
    await sleep(2000);
    await screenshot(`production-${name}-moving`);
    await sleep(6000);
    await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const result = await evaluate(
      `(()=>{const m=window.__productionFrames;m.active=false;const a=m.frames.sort((a,b)=>a-b);return {median:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:Math.max(...a),over50:a.filter(v=>v>50).length,frames:a.length,maxMph:Math.max(0,...m.mph),movingFrames:m.mph.filter(v=>v>5).length,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,coarse:matchMedia('(pointer:coarse)').matches}})()`,
    );
    report.runs.push({ name, rate: 2, ...result });
    console.log(`PRODUCTION ${name} ${JSON.stringify(result)}`);
    if (result.maxMph < 10 || result.overflow || !result.coarse)
      throw new Error(`Production ${name} touch drive failed`);
  }
}
try {
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: earlyMetrics });
  const opened = Date.now();
  await call("Page.navigate", { url });
  if (production) {
    await productionSmoke(opened);
  } else {
    await until("window.__taxi?.game.isReady === true");
    report.readyMs = Date.now() - opened;
    report.cold = await evaluate("window.__mobileCold");
    report.device = await evaluate(
      `(()=>{const r=window.__renderer,g=r.getContext(),d=g.getExtension('WEBGL_debug_renderer_info');return {coarse:matchMedia('(pointer:coarse)').matches,touch:navigator.maxTouchPoints,dpr:devicePixelRatio,width:innerWidth,height:innerHeight,renderer:d?g.getParameter(d.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER),ratio:r.getPixelRatio(),post:window.__post!==null}})()`,
    );
    if (!report.device.coarse || report.device.dpr !== 3 || report.device.post)
      throw new Error("Mobile render path not active");
    await tap("#banner-cta");
    await until('window.__taxi.game.mode.kind === "playing"');
    await evaluate(`(()=>{
    const m=window.__mobilePerf={active:false,frames:[],update:[],stream:[],render:[],calls:[],triangles:[],trajectory:[],movingFrames:[],tiers:[],longTasks:[]};
    function wrap(object,key,bucket){const original=object[key];object[key]=function(...args){const start=performance.now();const result=original.apply(this,args);if(m.active)m[bucket].push(performance.now()-start);return result;}}
    wrap(window.__taxi.game,'update','update');wrap(window.__taxi.game.city,'updateStreaming','stream');wrap(window.__renderer,'render','render');
    new PerformanceObserver(list=>{if(m.active)for(const e of list.getEntries())m.longTasks.push({start:e.startTime,duration:e.duration});}).observe({type:'longtask'});
    let previous=0;function frame(t){if(m.active){const car=window.__taxi.probe();if(previous){m.frames.push(t-previous);if(car?.speed>5)m.movingFrames.push(t-previous);}const tier=window.__perf.tier();if(m.tiers.at(-1)?.tier!==tier)m.tiers.push({tier,time:performance.now()});const r=window.__renderer.info.render;m.calls.push(r.calls);m.triangles.push(r.triangles);if(m.frames.length%30===0)m.trajectory.push(window.__taxi.probe());previous=t;}else previous=0;requestAnimationFrame(frame);}requestAnimationFrame(frame);
  })()`);
    await evaluate(
      `(()=>{const net=window.__taxi.game.city.network;const byId=new Map(net.edges.map(e=>[e.id,e]));let best=null;for(const first of net.edges){const mid=net.sample(first,first.len*.5);if(mid.x < -1150||mid.x > -650||mid.z<100||mid.z>650||first.half<3.5)continue;for(const direction of [1,-1]){let edge=first,dir=direction,length=0;const steps=[],seen=new Set();for(let count=0;count<30;count++){if(seen.has(edge.id))break;seen.add(edge.id);steps.push({edge,dir});length+=edge.len;const end=dir>0?edge.b:edge.a;const tangent=net.sample(edge,dir>0?edge.len:0);let next=null,score=.985;for(const id of net.nodeEdges[end]??[]){const candidate=byId.get(id);if(!candidate||seen.has(id))continue;const d=candidate.a===end?1:-1,p=net.sample(candidate,d>0?0:candidate.len),dot=tangent.tx*dir*p.tx*d+tangent.tz*dir*p.tz*d;if(dot>score){next={edge:candidate,dir:d};score=dot;}}if(!next)break;edge=next.edge;dir=next.dir;}if(length>240&&(!best||length>best.length))best={steps,length};}}if(!best)throw new Error('No 240-unit Sunset centreline route');const points=[];for(const {edge,dir}of best.steps)for(let s=0;s<edge.len;s+=6){const p=net.sample(edge,dir>0?s:edge.len-s);points.push({x:p.x,z:p.z});}const a=points[2],b=points[3];window.__mobileRoute={u:a.x/3172+.5,v:a.z/2600+.5,yaw:Math.atan2(b.x-a.x,b.z-a.z),points:points.slice(2),index:0,length:best.length};})()`,
    );
    report.route = await evaluate(
      "({u:window.__mobileRoute.u,v:window.__mobileRoute.v,yaw:window.__mobileRoute.yaw,length:window.__mobileRoute.length})",
    );
    console.log(`DEVICE ${JSON.stringify(report.device)} READY ${report.readyMs}ms`);
    for (const rate of rates) {
      await call("Emulation.setCPUThrottlingRate", { rate });
      await evaluate(
        "(()=>{window.__perf.pin(3);window.__perf.pin(null);window.__taxi.setTime(300);window.__taxi.teleport(window.__mobileRoute.u,window.__mobileRoute.v,window.__mobileRoute.yaw);window.__mobileRoute.index=0;window.__taxi.setPhase(.25);const t=window.__taxi,p=t.probe();t.game.traffic.reset({gx:t.game.city.gridX(p.x),gz:t.game.city.gridZ(p.z)},70);t.game.traffic.setHoldRecycle(true)})()",
      );
      if (ab)
        await evaluate(
          `window.__perf.pin(4);${iteration >= 1 ? "window.__taxi.game.city.group.updateMatrixWorld(true);window.__taxi.game.city.group.traverse(o=>{o.matrixWorldAutoUpdate=false})" : ""};${iteration >= 2 ? "window.__taxi.game.city.group.traverse(o=>{if(o.isBatchedMesh&&!o.castShadow&&!Array.isArray(o.material)&&!o.material.transparent)o.perObjectFrustumCulled=false})" : ""}`,
        );
      if (transitionProbe) await evaluate("window.__perf.pin(3)");
      await sleep(3500);
      const before = await evaluate(
        "({car:window.__taxi.probe(),tier:window.__perf.tier(),stream:window.__taxi.game.city.parcelStreamStats()})",
      );
      await evaluate(
        "(()=>{const m=window.__mobilePerf;for(const k of Object.keys(m))if(Array.isArray(m[k]))m[k]=[];m.active=true;})()",
      );
      if (rate === 4 && profile) {
        await call("Profiler.enable");
        await call("Profiler.setSamplingInterval", { interval: 1000 });
        await call("Profiler.start");
      }
      await call("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 100, y: 520, id: 1 }],
      });
      const driveUntil = Date.now() + durationMs;
      let transitioned = false;
      while (Date.now() < driveUntil) {
        if (transitionProbe && !transitioned && Date.now() > driveUntil - durationMs + 2500) {
          await evaluate("window.__perf.pin(4)");
          transitioned = true;
        }
        const steer = await evaluate(
          `(()=>{const r=window.__mobileRoute,p=window.__taxi.probe();let index=r.index,distance=Infinity;for(let i=r.index;i<Math.min(r.index+20,r.points.length);i++){const q=r.points[i],d=Math.hypot(q.x-p.x,q.z-p.z);if(d<distance){distance=d;index=i;}}r.index=index;const q=r.points[Math.min(index+2,r.points.length-1)],want=Math.atan2(q.x-p.x,q.z-p.z),error=((want-p.heading+Math.PI*3)%(Math.PI*2))-Math.PI;return Math.max(-.8,Math.min(.8,-error*1.7));})()`,
        );
        await call("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: 100 + steer * 62, y: 520, id: 1 }],
        });
        await sleep(100);
      }
      await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      if (rate === 4 && profile) {
        const { profile } = await call("Profiler.stop");
        writeFileSync(path.join(output, "cpu-4x.json"), JSON.stringify(profile));
      }
      const result = await evaluate(
        `(()=>{const m=window.__mobilePerf;m.active=false;const summary=(values)=>{const a=[...values].sort((a,b)=>a-b);const p=q=>a[Math.min(a.length-1,Math.floor(a.length*q))]??0;return {count:a.length,median:p(.5),p95:p(.95),p99:p(.99),max:p(1),over33:a.filter(v=>v>33.4).length,over50:a.filter(v=>v>50).length,over100:a.filter(v=>v>100).length};};return {frames:summary(m.frames),movingFrames:summary(m.movingFrames),tiers:m.tiers,updateMs:summary(m.update),streamMs:summary(m.stream),renderMs:summary(m.render),calls:summary(m.calls),triangles:summary(m.triangles),longTasks:m.longTasks,trajectory:m.trajectory,after:{car:window.__taxi.probe(),tier:window.__perf.tier(),ratio:window.__renderer.getPixelRatio(),stream:window.__taxi.game.city.parcelStreamStats()}}})()`,
      );
      const run = {
        rate,
        scenario: ab
          ? ["baseline", "static-world-matrices", "matrices-and-batch-cache"][iteration]
          : transitionProbe
            ? "first-shadowless-transition"
            : "adaptive",
        traffic: "isolated route: fleet relocated, recycler held",
        before,
        ...result,
      };
      iteration++;
      report.runs.push(run);
      if (result.movingFrames.count < result.frames.count * 0.8) {
        throw new Error("Route did not sustain movement for 80% of sampled frames");
      }
      if (transitionProbe && result.frames.max > 1000) {
        throw new Error("First shadowless transition stalled longer than one second");
      }
      console.log(
        `DRIVE ${rate}x ${JSON.stringify({ ...run, trajectory: undefined, longTasks: run.longTasks.map((x) => Math.round(x.duration)) })}`,
      );
      await screenshot(`drive-${rate}x-${run.scenario}`);
      // Reconciliation of a distant neighbourhood is deliberately reported
      // separately from continuous driving; teleports are a loading event.
      const change = await evaluate(
        `(()=>{const m=window.__mobilePerf;m.active=true;m.frames=[];m.stream=[];m.update=[];m.render=[];const t=performance.now();window.__taxi.teleport(.738,.19);return {syncMs:performance.now()-t};})()`,
      );
      await sleep(2500);
      const transition = await evaluate(
        `(()=>{const m=window.__mobilePerf;m.active=false;return {frameMax:Math.max(0,...m.frames),streamMax:Math.max(0,...m.stream),longFrames:m.frames.filter(v=>v>50).length,stream:window.__taxi.game.city.parcelStreamStats()}})()`,
      );
      run.transition = { ...change, ...transition };
      console.log(`TRANSITION ${rate}x ${JSON.stringify(run.transition)}`);
    }
  }
  report.pageErrors = pageErrors;
  if (pageErrors.length) process.exitCode = 1;
} catch (error) {
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
  await screenshot("failure").catch(() => {});
} finally {
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  close();
}

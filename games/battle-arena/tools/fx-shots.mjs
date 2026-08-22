// Freeze-frame FX capture.
//
// Drives ?viewer=1 through agent-browser, loops each ability through the actual
// sim, and freezes the instant a chosen object appears — then parks the camera
// on it and saves a PNG. The freeze is `setAnimationLoop(null)`: sim time only
// ever advances inside that loop, so nothing unwinds and the canvas keeps the
// last presented frame for the screenshot.
//
// Without the freeze every capture is a coin flip — a meteor is only in the air
// for 650ms of a multi-second cast loop.
//
//   node tools/fx-shots.mjs [outDir]
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const URL = process.env.VG_URL ?? "http://localhost:5194/?viewer=1";
const OUT = process.argv[2] ?? "fx-shots";
// Per-process by default: two overlapping runs sharing one session would drive
// the same browser, so one run's navigate lands mid-capture in the other.
// Override to reuse a warm browser across runs when nothing else is running.
const SHARED_SESSION = process.env.VG_SESSION;
const SESSION = SHARED_SESSION ?? `battle-arena-fx-${process.pid}`;

/**
 * Each shot names a champion, an ability, and what to wait for. `find` is a JS
 * expression run against every object in the scene; the first match freezes it.
 * `cam` is an offset from the point the shot aims at. `aim` overrides where
 * that point is — needed for anything built in world space by a vertex shader,
 * whose mesh never leaves the origin.
 */
const ERUPTION =
  "o.isInstancedMesh && o.count > 0 && o.geometry.attributes.aBirth && " +
  // birth decays over rise*2.2, so this window lands just after the blades top out
  "[...o.geometry.attributes.aBirth.array].some((v) => v > 0.35 && v < 0.72)";

const SHOTS = [
  {
    name: "meteor-rock",
    champ: "V-yx",
    ability: "Meteor",
    find: "o.isMesh && o.material && o.material.flatShading && o.position.y > 1.2 && o.position.y < 4.5",
    cam: [3.4, 1.6, 4.2],
  },
  {
    name: "meteor-impact",
    champ: "V-yx",
    ability: "Meteor",
    find: "o.isMesh && o.visible && o.material && o.material.uniforms && o.material.uniforms.uShell",
    cam: [6, 3.5, 9],
  },
  {
    name: "frost-nova",
    champ: "V-yx",
    ability: "Frost Nova",
    find: ERUPTION,
    cam: [5.5, 3.4, 6.5],
  },
  {
    name: "bog-grasp",
    champ: "Grimelda",
    ability: "Bog Grasp",
    find: ERUPTION,
    cam: [5.5, 3.4, 6.5],
  },
  {
    name: "snare-trap",
    champ: "Sylva",
    ability: "Snare Trap",
    find: ERUPTION,
    cam: [5.5, 3.4, 6.5],
  },
  {
    name: "smite",
    champ: "Aurelius",
    ability: "Consecrating Smite",
    find: "o.isMesh && o.visible && o.material && o.material.uniforms && o.material.uniforms.uProgress && o.material.uniforms.uProgress.value > 0.9",
    aim: "o.material.uniforms.uTarget.value",
    cam: [7, 5, 9],
  },
  {
    name: "seismic-slam",
    champ: "Garran",
    ability: "Seismic Slam",
    find: "o.isMesh && o.visible && o.material && o.material.uniforms && o.material.uniforms.uPulse && o.material.uniforms.uT && o.material.uniforms.uT.value < 0.4",
    cam: [0.2, 6.5, 1.2], // near-overhead: a ground decal is only legible flat on
  },
];

const ab = (...args) =>
  execFileSync("agent-browser", [...args, "--session", SESSION], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * Run JS in the page and parse what it returned.
 *
 * agent-browser prints its own status lines ("[agent-browser] launched
 * browser") ahead of the value on a cold session, so those are stripped before
 * parsing or the first call of a run comes back as an unparsed string.
 */
const evalJs = (js) => {
  const out = ab("eval", js)
    .split("\n")
    .filter((line) => !line.startsWith("[agent-browser]"))
    .join("\n")
    .trim();
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Click the first leaf element whose text starts with `label`. */
const clickByText = (label) =>
  evalJs(
    `(() => { const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.textContent || "").trim().startsWith(${JSON.stringify(label)})); if (el) (el.closest("button") || el.parentElement || el).click(); return !!el; })()`,
  );

const armFreeze = (shot) =>
  evalJs(`(() => {
  const w = window;
  const test = (o) => { try { return (${shot.find}); } catch { return false; } };
  const aim = ${shot.aim ? `(o) => (${shot.aim})` : "null"};
  const cam = ${JSON.stringify(shot.cam)};
  const view = w.__view;
  const scene = view.scene;
  w.__hit = null;
  const tick = () => {
    if (w.__hit) return;
    let found = null;
    scene.traverse((o) => { if (!found && test(o)) found = o; });
    if (found) {
      found.updateWorldMatrix(true, false);
      const p = found.position.clone().setFromMatrixPosition(found.matrixWorld);
      if (aim) p.copy(aim(found));
      // An InstancedMesh sits at the origin — the eruption is in the instance
      // matrices. Aim at the first live instance instead, or the camera parks
      // in the middle of the arena looking at nothing.
      else if (found.isInstancedMesh) {
        const m = new found.matrixWorld.constructor();
        for (let i = 0; i < found.count; i++) {
          found.getMatrixAt(i, m);
          const q = p.clone().setFromMatrixPosition(m);
          if (q.y > -50) { p.copy(q); break; }
        }
      }
      w.__hit = { x: p.x, y: p.y, z: p.z };
      const c = view.camera;
      c.position.set(p.x + cam[0], p.y + cam[1], p.z + cam[2]);
      c.lookAt(p.x, p.y, p.z);
      c.updateMatrixWorld();
      // Draw one frame by hand: the loop is about to stop, so nothing else will.
      view.renderer.render(scene, c);
      view.renderer.setAnimationLoop(null);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return "armed";
})()`);

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const results = [];
  try {
    // Headed: a software GL stack renders these shaders, but not at a framerate
    // the sub-second capture windows survive.
    //
    // Retried because a run that owns its session closes it on the way out: two
    // runs back to back race the previous browser's teardown, which surfaces as
    // "Failed to connect" on the very next command.
    for (let i = 0; ; i++) {
      try {
        ab("open", URL, "--headed");
        ab("set", "viewport", "1280", "800");
        break;
      } catch (err) {
        if (i === 2) throw err;
        await sleep(2000);
      }
    }

    for (const shot of SHOTS) {
      // Fresh page per shot — the previous freeze left the render loop stopped.
      ab("navigate", URL);
      let booted = false;
      for (let i = 0; i < 60 && !booted; i++) {
        booted = evalJs("!!window.__view") === true;
        if (!booted) await sleep(500);
      }
      // A shot whose viewer never booted is reported rather than thrown: one
      // bad boot must not abort every remaining capture. It is tagged
      // separately from a freeze miss, because the two point at completely
      // different problems — a dead dev server versus a stale `find`.
      if (!booted) {
        results.push({ shot: shot.name, frozen: false, reason: "no-boot" });
        console.log(`✗ ${shot.name} — viewer never published window.__view`);
        continue;
      }
      await sleep(6000); // models and the arena finish loading

      const champ = clickByText(shot.champ);
      await sleep(600);
      const ability = clickByText(shot.ability);
      armFreeze(shot);

      // agent-browser serialises a returned object as JSON, so evalJs hands
      // back the point directly — no second decode step to get wrong.
      let hit = null;
      for (let i = 0; i < 50 && !hit; i++) {
        await sleep(500);
        hit = evalJs("window.__hit ?? null");
      }
      ab("screenshot", `${OUT}/${shot.name}.png`);
      results.push({ shot: shot.name, frozen: !!hit, reason: hit ? null : "no-freeze" });
      console.log(`${hit ? "✓" : "✗"} ${shot.name}`, { champ, ability }, hit ?? "");
    }
  } finally {
    // Only a session this run created: an explicitly named one is the caller's
    // warm browser to reuse, and closing it would defeat the point of naming it.
    if (!SHARED_SESSION) {
      try {
        ab("close");
      } catch {
        // already gone
      }
    }
  }

  const missed = results.filter((r) => !r.frozen);
  console.log(`\n${results.length - missed.length}/${results.length} frozen → ${OUT}/`);
  for (const reason of ["no-boot", "no-freeze"]) {
    const hits = missed.filter((m) => m.reason === reason).map((m) => m.shot);
    if (hits.length) console.log(`${reason}: ${hits.join(", ")}`);
  }
};

main();

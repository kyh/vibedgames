// Freeze-frame FX capture harness.
//
// Drives ?viewer=1 in a real Chrome, loops each ability through the
// actual sim, and freezes the instant a chosen object appears — then parks the
// camera on it and saves a PNG. The freeze is `setAnimationLoop(null)`: sim
// time only ever advances inside that loop, so nothing unwinds and the canvas
// keeps the last presented frame.
//
// Without this every capture is a coin flip — a meteor is only in the air for
// 650ms of a multi-second cast loop, and a screenshot round-trip is ~1s.
//
//   node tools/fx-shots.mjs [outDir]
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const URL = process.env.VG_URL ?? "http://localhost:5194/?viewer=1";
const OUT = process.argv[2] ?? "fx-shots";

/**
 * Each shot names a champion, an ability, and what to wait for. `find` runs in
 * the page against every object in the scene; the first match freezes it.
 * `cam` is an offset from the point the shot aims at, or null to keep the live
 * camera. `aim` overrides where that point is — needed for anything built in
 * world space by a vertex shader, whose mesh never leaves the origin.
 */
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
    find: "o.isInstancedMesh && o.count > 0 && o.geometry.attributes.aBirth && [...o.geometry.attributes.aBirth.array].some((v) => v > 0.35 && v < 0.72)",
    cam: [5.5, 3.4, 6.5],
  },
  {
    name: "bog-grasp",
    champ: "Grimelda",
    ability: "Bog Grasp",
    find: "o.isInstancedMesh && o.count > 0 && o.geometry.attributes.aBirth && [...o.geometry.attributes.aBirth.array].some((v) => v > 0.35 && v < 0.72)",
    cam: [5.5, 3.4, 6.5],
  },
  {
    name: "snare-trap",
    champ: "Sylva",
    ability: "Snare Trap",
    find: "o.isInstancedMesh && o.count > 0 && o.geometry.attributes.aBirth && [...o.geometry.attributes.aBirth.array].some((v) => v > 0.35 && v < 0.72)",
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

const PAGE_HELPERS = () => {
  const w = /** @type {any} */ (window);
  w.__pick = (t) => {
    const el = [...document.querySelectorAll("*")].find(
      (e) => e.children.length === 0 && (e.textContent || "").trim().startsWith(t),
    );
    if (el) (el.closest("button") || el.parentElement || el).click();
    return !!el;
  };
  w.__armFreeze = (findSrc, cam, aimSrc) => {
    const view = w.__view;
    const scene = view.scene;
    const test = new Function("o", `try { return (${findSrc}); } catch (e) { return false; }`);
    const aim = aimSrc ? new Function("o", `return (${aimSrc});`) : null;
    w.__hit = null;
    const tick = () => {
      if (w.__hit) return;
      let found = null;
      scene.traverse((o) => {
        if (!found && test(o)) found = o;
      });
      if (found) {
        found.updateWorldMatrix(true, false);
        const p = found.position.clone().setFromMatrixPosition(found.matrixWorld);
        if (aim) p.copy(aim(found));
        // An InstancedMesh sits at the origin — the eruption is in the instance
        // matrices. Aim at the first live instance instead, or the camera parks
        // in the middle of the arena looking at nothing.
        if (!aim && found.isInstancedMesh) {
          const m = new found.matrixWorld.constructor();
          for (let i = 0; i < found.count; i++) {
            found.getMatrixAt(i, m);
            const q = p.clone().setFromMatrixPosition(m);
            if (q.y > -50) {
              p.copy(q);
              break;
            }
          }
        }
        w.__hit = { x: p.x, y: p.y, z: p.z };
        if (cam) {
          const c = view.camera;
          c.position.set(p.x + cam[0], p.y + cam[1], p.z + cam[2]);
          c.lookAt(p.x, p.y, p.z);
          c.updateMatrixWorld();
          view.renderer.render(scene, c);
        }
        view.renderer.setAnimationLoop(null);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  // Headed + real Chrome: the same requirement the waymo harnesses have. A
  // headless GL stack renders these shaders, but not at a framerate the 650ms
  // capture windows survive.
  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const results = [];
  for (const shot of SHOTS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(URL, { waitUntil: "domcontentloaded" });
      await page.waitForFunction("!!window.__view", null, { timeout: 60_000 });
      await page.waitForTimeout(6000);
      await page.evaluate(PAGE_HELPERS);
      const picked = await page.evaluate(
        ([champ, ability]) => {
          const w = /** @type {any} */ (window);
          const c = w.__pick(champ);
          return new Promise((res) =>
            setTimeout(() => res({ champ: c, ability: w.__pick(ability) }), 600),
          );
        },
        [shot.champ, shot.ability],
      );
      await page.evaluate(
        ([findSrc, cam, aimSrc]) => /** @type {any} */ (window).__armFreeze(findSrc, cam, aimSrc),
        [shot.find, shot.cam, shot.aim ?? null],
      );
      const hit = await page
        .waitForFunction("window.__hit", null, { timeout: 25_000, polling: 100 })
        .then((h) => h.jsonValue())
        .catch(() => null);
      await page.screenshot({ path: `${OUT}/${shot.name}.png` });
      results.push({ shot: shot.name, ...picked, frozen: !!hit });
      console.log(`${hit ? "✓" : "✗"} ${shot.name}`, picked, hit ?? "");
    } catch (err) {
      console.log(`✗ ${shot.name}`, err.message);
      results.push({ shot: shot.name, error: err.message });
    } finally {
      await page.close();
    }
  }
  await browser.close();
  const missed = results.filter((r) => !r.frozen);
  console.log(`\n${results.length - missed.length}/${results.length} frozen → ${OUT}/`);
  if (missed.length) console.log("missed:", missed.map((m) => m.shot).join(", "));
};

main();

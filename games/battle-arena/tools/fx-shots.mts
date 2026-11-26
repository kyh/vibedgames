import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const URL = process.env.VG_URL ?? "http://localhost:5194/?viewer=1";
const OUT = process.argv[2] ?? "fx-shots";
const SHARED_SESSION = process.env.VG_SESSION;
const SESSION = SHARED_SESSION ?? `battle-arena-fx-${process.pid}`;

const ERUPTION =
  "o.isInstancedMesh && o.count > 0 && o.geometry.attributes.aBirth && " +
  "[...o.geometry.attributes.aBirth.array].some((v) => v > 0.35 && v < 0.72)";

const SHOTS = [
  {
    ability: "Meteor",
    cam: [3.4, 1.6, 4.2],
    champ: "V-yx",
    find: "o.isMesh && o.material && o.material.flatShading && o.position.y > 1.2 && o.position.y < 4.5",
    name: "meteor-rock",
  },
  {
    ability: "Meteor",
    cam: [6, 3.5, 9],
    champ: "V-yx",
    find: "o.isMesh && o.visible && o.material && o.material.uniforms && o.material.uniforms.uShell",
    name: "meteor-impact",
  },
  {
    ability: "Frost Nova",
    cam: [5.5, 3.4, 6.5],
    champ: "V-yx",
    find: ERUPTION,
    name: "frost-nova",
  },
  {
    ability: "Bog Grasp",
    cam: [5.5, 3.4, 6.5],
    champ: "Grimelda",
    find: ERUPTION,
    name: "bog-grasp",
  },
  {
    ability: "Snare Trap",
    cam: [5.5, 3.4, 6.5],
    champ: "Sylva",
    find: ERUPTION,
    name: "snare-trap",
  },
  {
    ability: "Consecrating Smite",
    aim: "o.material.uniforms.uCentre.value",
    cam: [7, 5, 9],
    champ: "Aurelius",
    find: "o.isMesh && o.visible && o.material && o.material.uniforms && o.material.uniforms.uGrown && o.material.uniforms.uHeight && o.material.uniforms.uGrown.value > 0.99 && o.material.uniforms.uCharge.value < 0.4",
    name: "smite",
  },
  {
    ability: "Grand Hex",
    cam: [6, 2.5, 7],
    champ: "Grimelda",
    find: "o.isMesh && o.visible && o.material && o.material.uniforms && o.material.uniforms.uHorizon && o.material.uniforms.uChurn && o.material.uniforms.uChurn.value < 0.05",
    name: "grand-hex",
  },
  {
    ability: "Cauldron Brew",
    cam: [4, 5.5, 5],
    champ: "Grimelda",
    find: "o.isMesh && o.visible && o.material && o.material.uniforms && o.material.uniforms.uGrown && o.material.uniforms.uSpent && o.material.uniforms.uFront.value < 0.05",
    name: "cauldron-brew",
  },
  {
    ability: "Hex Bolt",
    aim: "o.material.uniforms.uHead.value",
    cam: [3, 1.5, 3.5],
    champ: "Grimelda",
    find: "o.isMesh && o.visible && o.material && o.material.uniforms && o.material.uniforms.uSpan && o.material.uniforms.uHead && o.material.uniforms.uSpan.value > 4.4",
    name: "hex-bolt",
  },
  {
    ability: "Seismic Slam",
    cam: [0.2, 6.5, 1.2],
    champ: "Garran",
    find: "o.isMesh && o.visible && o.material && o.material.uniforms && o.material.uniforms.uPulse && o.material.uniforms.uT && o.material.uniforms.uT.value < 0.4",
    name: "seismic-slam",
  },
];

const ab = (...args: string[]) =>
  execFileSync("agent-browser", [...args, "--session", SESSION], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const evalJs = (js: string) => {
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

const clickByText = (label: string) =>
  evalJs(
    `(() => { const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.textContent || "").trim().startsWith(${JSON.stringify(label)})); if (el) (el.closest("button") || el.parentElement || el).click(); return !!el; })()`,
  );

const armFreeze = (
  shot:
    | { ability: string; cam: number[]; champ: string; find: string; name: string; aim?: undefined }
    | { ability: string; aim: string; cam: number[]; champ: string; find: string; name: string },
) =>
  evalJs(`(() => {
  const w = window;
  const test = (o) => { try { return (${shot.find}); } catch { return false; } };
  const aim = ${shot.aim !== undefined && shot.aim !== "" ? `(o) => (${shot.aim})` : "null"};
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
    for (let i = 0; ; i += 1) {
      try {
        ab("open", URL, "--headed");
        ab("set", "viewport", "1280", "800");
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        }

        await sleep(2000);
      }
    }

    for (const shot of SHOTS) {
      ab("navigate", URL);
      let booted = false;

      for (let i = 0; i < 60 && !booted; i += 1) {
        booted = evalJs("!!window.__view") === true;

        if (!booted) {
          await sleep(500);
        }
      }

      if (!booted) {
        results.push({ frozen: false, reason: "no-boot", shot: shot.name });
        console.log(`✗ ${shot.name} — viewer never published window.__view`);
        continue;
      }

      await sleep(6000);

      const champ = clickByText(shot.champ);
      await sleep(600);
      const ability = clickByText(shot.ability);
      armFreeze(shot);

      let hit = null;

      for (let i = 0; i < 50 && !hit; i += 1) {
        await sleep(500);
        hit = evalJs("window.__hit ?? null");
      }

      ab("screenshot", `${OUT}/${shot.name}.png`);
      results.push({ frozen: !!hit, reason: hit ? null : "no-freeze", shot: shot.name });
      console.log(`${hit ? "✓" : "✗"} ${shot.name}`, { ability, champ }, hit ?? "");
    }
  } finally {
    if (SHARED_SESSION === undefined || SHARED_SESSION === "") {
      try {
        ab("close");
      } catch (closeError) {
        console.warn(`browser close failed: ${String(closeError)}`);
      }
    }
  }

  const missed = results.filter((r) => !r.frozen);
  console.log(`\n${results.length - missed.length}/${results.length} frozen → ${OUT}/`);

  for (const reason of ["no-boot", "no-freeze"]) {
    const hits = missed.flatMap((m) => (m.reason === reason ? [m.shot] : []));

    if (hits.length) {
      console.log(`${reason}: ${hits.join(", ")}`);
    }
  }
};

main();

import type * as THREE from "three";
import { InstancedMesh } from "three";

// `?gpuprobe=1` — bisect a GPU-process crash against the REAL scene. The
// generic feature probe (public/probe.html) passes on a driver that still
// kills this game on its first frame, so the culprit is a combination only
// this scene builds. Reveal the scene one top-level object at a time, draw a
// few frames each, and keep the current object's description on screen above
// every other surface: the DOM survives a lost context, the canvas does not.
export const isGpuProbeRequested = (): boolean =>
  new URLSearchParams(window.location.search).get("gpuprobe") === "1";

const describe = (o: THREE.Object3D): string => {
  const parts = [o.name || o.type];
  if ("geometry" in o && o.geometry instanceof Object && "type" in o.geometry) {
    parts.push(String(o.geometry.type));
  }
  if ("material" in o) {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m instanceof Object && "type" in m) {
        const flags = [
          "transparent" in m && m.transparent ? "transparent" : "",
          "depthWrite" in m && m.depthWrite === false ? "noDepthWrite" : "",
          "map" in m && m.map ? "map" : "",
        ]
          .filter(Boolean)
          .join(",");
        parts.push(`${String(m.type)}${flags ? `[${flags}]` : ""}`);
      }
    }
  }
  if (o instanceof InstancedMesh) {
    parts.push(`×${o.count}`);
  }
  if (o.castShadow) {
    parts.push("castShadow");
  }
  return `${parts.join(" ")} (${o.children.length} children)`;
};

const frames = (n: number): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps requestAnimationFrame
  new Promise((resolve) => {
    let i = 0;
    const tick = (): void => {
      i += 1;
      if (i >= n) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });

export const runGpuProbe = async (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<void> => {
  const panel = document.createElement("pre");
  panel.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:2147483001;margin:0;padding:12px;" +
    "background:rgba(11,14,20,.92);color:#f4f7fb;font:12px/1.4 monospace;white-space:pre-wrap;word-break:break-word;max-height:70vh;overflow:auto";
  document.body.append(panel);
  const lines: string[] = ["gpuprobe: revealing the scene one object at a time"];
  const show = (): void => {
    panel.textContent = lines.join("\n");
  };
  show();

  const objects = [...scene.children];
  for (const o of objects) {
    o.visible = false;
  }
  renderer.render(scene, camera);
  await frames(10);
  for (const [i, o] of objects.entries()) {
    lines.push(`… ${i + 1}/${objects.length} ${describe(o)}`);
    show();
    o.visible = true;
    for (let f = 0; f < 12; f += 1) {
      renderer.render(scene, camera);
      await frames(1);
      if (renderer.getContext().isContextLost()) {
        lines.push(`LOST on ${i + 1}: ${describe(o)}`);
        show();
        return;
      }
    }
    lines[lines.length - 1] = `ok ${i + 1}/${objects.length} ${describe(o)}`;
    show();
  }
  lines.push("DONE — every object survived. Screenshot this.");
  show();
};

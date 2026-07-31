#!/usr/bin/env -S uv run --python 3.12 --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Render a generated Three.js factory to PNGs at canonical angles.

The upstream pass gate needs a browser render before it will unlock the next
pass, but leaves producing one to "your agent's browser tool". This does it
deterministically: mount the factory in a throwaway Vite entry, frame the model
by its own bounding box, and shoot fixed angles on a neutral backdrop.

Deterministic by construction — fixed camera ring, fixed lights, no animation —
so two renders of the same spec differ only where the model changed.

    uv run render_model.py --project sandbox/chest-quest \
        --factory src/model/chest-factory.generated.ts \
        --export createTreasureChestModel --out-dir runs/blockout

Writes <out-dir>/<view>.png plus contact.json (mesh/material/geometry counts).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

HARNESS_DIR = ".i2t-render"

# Azimuth/elevation degrees. `three-quarter` is first because it is the view
# reference images are usually asked for and the one reviews should score.
VIEWS: dict[str, tuple[float, float]] = {
    "three-quarter": (35.0, 22.0),
    "front": (0.0, 12.0),
    "side": (90.0, 12.0),
    "back": (180.0, 12.0),
    "top": (35.0, 65.0),
    # Grazing view for flat props: surface-pass judges normal/height detail
    # under raking light, and "side" is dead edge-on for anything flat.
    "raking": (15.0, 3.0),
}

INDEX_HTML = """<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>i2t render</title>
    <style>html,body{margin:0;height:100%;background:#b8b8b8}canvas{display:block}</style>
  </head>
  <body><script type="module" src="./main.ts"></script></body>
</html>
"""

MAIN_TS = """import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { %(export_name)s as factory } from "%(factory_import)s";

const SIZE = %(size)d;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb8b8b8);

const model = factory({ castShadow: false, receiveShadow: false });
scene.add(model);

// The pass gate wants map-stripped evidence: procedural albedo/roughness maps
// can flatter a wrong shape, so geometry gets reviewed on its own. Neutral matte
// keeps the light rig, which is what makes form readable at all.
if (%(map_stripped)s) {
  const matte = new THREE.MeshStandardMaterial({ color: 0xc9c9c9, roughness: 1, metalness: 0 });
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.material = matte;
  });
}

// Metals need something to reflect. Without an environment map a high-metalness
// PBR material renders pure BLACK, which reads as "my material is broken"
// rather than "my scene has no reflections" — so always light metal with an env.
if (!%(map_stripped)s) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
}

// Neutral three-point rig: enough to read form without editorialising the look.
scene.add(new THREE.AmbientLight(0xffffff, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 5, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.8);
fill.position.set(-4, 2, -3);
scene.add(fill);

const box = new THREE.Box3().setFromObject(model);
const size = box.getSize(new THREE.Vector3());
const center = box.getCenter(new THREE.Vector3());
const radius = Math.max(size.x, size.y, size.z) * 1.25 || 1;

const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);

function shoot(azimuthDeg: number, elevationDeg: number) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const dist = radius / Math.tan((camera.fov * Math.PI) / 360);
  camera.position.set(
    center.x + dist * Math.cos(el) * Math.sin(az),
    center.y + dist * Math.sin(el),
    center.z + dist * Math.cos(el) * Math.cos(az),
  );
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL("image/png");
}

const meshes: string[] = [];
const materials = new Set<string>();
const geometries = new Set<string>();
model.traverse((o) => {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh) return;
  meshes.push(mesh.name || "(unnamed)");
  geometries.add(mesh.geometry.uuid);
  for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    materials.add(m.uuid);
  }
});

const sockets: string[] = [];
const pivots: string[] = [];
model.traverse((o) => {
  if (o.name.includes("socket")) sockets.push(o.name);
  if (o.name.endsWith("__pivot")) pivots.push(o.name);
});

Object.assign(window, {
  __render: {
    shoot,
    contact: {
      meshCount: meshes.length,
      meshNames: meshes,
      materialCount: materials.size,
      geometryCount: geometries.size,
      sockets,
      pivots,
      boundsSize: [size.x, size.y, size.z],
    },
  },
});
"""

SHOOT_JS = """const pw = await import(%(playwright)s);
const chromium = pw.chromium ?? pw.default.chromium;
const views = %(views)s;
const outDir = %(out_dir)s;
const size = %(size)d;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: size, height: size } });
const problems = [];
page.on('pageerror', (e) => problems.push(String(e).split('\\n')[0]));
page.on('console', (m) => m.type() === 'error' && problems.push('console: ' + m.text()));

await page.goto(%(url)s, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__render), null, { timeout: 30000 });

const fs = await import('node:fs');
const suffix = %(stripped_suffix)s;
for (const [name, [az, el]] of Object.entries(views)) {
  const dataUrl = await page.evaluate(([a, e]) => window.__render.shoot(a, e), [az, el]);
  fs.writeFileSync(`${outDir}/${name}${suffix}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
}
const contact = await page.evaluate(() => window.__render.contact);
// A stripped run overrides every material, so its counts describe the override,
// not the model — keep its contact separate or run order decides what's recorded.
fs.writeFileSync(`${outDir}/contact${suffix}.json`, JSON.stringify({ ...contact, problems }, null, 2));
console.log(JSON.stringify({ views: Object.keys(views), problems }));
await browser.close();
"""


def find_playwright(project: Path) -> str:
    """Locate an installed playwright ESM entry, walking up to the workspace root."""
    for base in [project, *project.parents]:
        hits = sorted(glob.glob(str(base / "node_modules/.pnpm/playwright@*/node_modules/playwright/index.mjs")))
        if hits:
            return hits[-1]
        direct = base / "node_modules/playwright/index.mjs"
        if direct.exists():
            return str(direct)
    raise SystemExit(
        "could not find playwright. Install it in the project or run from a workspace that has it."
    )


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_for_http(url: str, timeout: float) -> bool:
    import urllib.error
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except urllib.error.HTTPError:
            return True
        except OSError:
            time.sleep(0.4)
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True, help="Vite project with three installed")
    ap.add_argument("--factory", required=True, help="Generated factory, relative to --project")
    ap.add_argument("--export", dest="export_name", required=True, help="Factory export, e.g. createFooModel")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--views", default="three-quarter,front,side", help=f"any of: {','.join(VIEWS)}")
    ap.add_argument("--size", type=int, default=768)
    ap.add_argument("--keep-harness", action="store_true", help="leave the temp Vite entry in place for debugging")
    ap.add_argument(
        "--map-stripped",
        action="store_true",
        help="override every material with a neutral matte and write <view>-stripped.png; "
        "the pass gate requires this as geometry evidence alongside the lit renders",
    )
    ap.add_argument(
        "--elevation",
        type=float,
        default=None,
        help="override the elevation (degrees) of every chosen view — match the reference's "
        "camera pitch before comparing silhouettes or IoU gates false-negative",
    )
    args = ap.parse_args()

    project = Path(args.project).resolve()
    factory = (project / args.factory).resolve()
    if not factory.exists():
        raise SystemExit(f"factory not found: {factory}")

    chosen = {}
    for name in [v.strip() for v in args.views.split(",") if v.strip()]:
        if name not in VIEWS:
            raise SystemExit(f"unknown view '{name}'; choose from {','.join(VIEWS)}")
        az, el = VIEWS[name]
        chosen[name] = (az, args.elevation if args.elevation is not None else el)

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    harness = project / HARNESS_DIR
    harness.mkdir(exist_ok=True)
    rel = os.path.relpath(factory, harness).replace(os.sep, "/")
    if not rel.startswith("."):
        rel = f"./{rel}"
    (harness / "index.html").write_text(INDEX_HTML)
    (harness / "main.ts").write_text(
        MAIN_TS
        % {
            "export_name": args.export_name,
            "factory_import": rel,
            "size": args.size,
            "map_stripped": "true" if args.map_stripped else "false",
        }
    )

    port = free_port()
    vite = subprocess.Popen(
        ["npx", "vite", "--port", str(port), "--strictPort"],
        cwd=project,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        url = f"http://localhost:{port}/{HARNESS_DIR}/"
        if not wait_for_http(url, timeout=60):
            out = vite.stdout.read() if vite.stdout else ""
            raise SystemExit(f"vite did not come up on {port}\n{out[-1500:]}")

        script = SHOOT_JS % {
            "playwright": json.dumps(find_playwright(project)),
            "views": json.dumps(chosen),
            "out_dir": json.dumps(str(out_dir)),
            "url": json.dumps(url),
            "size": args.size,
            "stripped_suffix": json.dumps("-stripped" if args.map_stripped else ""),
        }
        shot = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            capture_output=True,
            text=True,
        )
        if shot.returncode != 0:
            sys.stderr.write(shot.stderr[-2000:])
            raise SystemExit("render failed")
        print(shot.stdout.strip())
    finally:
        vite.terminate()
        try:
            vite.wait(timeout=10)
        except subprocess.TimeoutExpired:
            vite.kill()
        if not args.keep_harness:
            shutil.rmtree(harness, ignore_errors=True)

    contact_name = "contact-stripped.json" if args.map_stripped else "contact.json"
    contact = json.loads((out_dir / contact_name).read_text())
    print(
        f"  meshes={contact['meshCount']} materials={contact['materialCount']} "
        f"geometries={contact['geometryCount']} pivots={len(contact['pivots'])} sockets={len(contact['sockets'])}"
    )
    if contact["problems"]:
        print("  PROBLEMS:", *contact["problems"][:5], sep="\n    ")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

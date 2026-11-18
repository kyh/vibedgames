// Blue hour: a deep zenith, a warm band where the sun has just gone, thin
// cloud catching the last of it, the first stars, and a ring of far skyline so
// the district never ends at a visible edge.

import * as THREE from "three";

import { cloudBands, seeded } from "./textures";

export interface SkyPalette {
  zenith: string;
  mid: string;
  horizon: string;
  /** The glow around where the sun set. */
  sun: string;
  /** Far skyline silhouette. */
  skyline: string;
}

const VERTEX = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = `
  uniform vec3 uZenith;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  uniform vec3 uSun;
  uniform vec3 uSunDir;
  varying vec3 vDir;
  void main() {
    vec3 dir = normalize(vDir);
    float up = clamp(dir.y, -1.0, 1.0);
    vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, up));
    col = mix(col, uZenith, smoothstep(0.16, 0.7, up));
    // The afterglow: a wide warm wash low on the sun's side, a tight hot core.
    float toward = max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
    float low = exp(-max(up, 0.0) * 6.0);
    col += uSun * pow(toward, 3.0) * low * 0.9;
    col += uSun * pow(max(dot(dir, normalize(uSunDir)), 0.0), 90.0) * 1.4;
    // Below the horizon: fade to the haze colour so the dome has no hard floor.
    col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.25, up));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const skylineTexture = (seed: number): THREE.CanvasTexture => {
  const random = seeded(seed);
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    let x = 0;
    while (x < 2048) {
      const w = 14 + random() * 46;
      const h = 30 + random() * random() * 210;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, 256 - h, w, h);
      // A few lit windows, so the silhouette reads as buildings, not a wall.
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      for (let i = 0; i < h / 7; i += 1) {
        if (random() < 0.5) {
          ctx.fillRect(x + 3 + random() * (w - 8), 256 - h + 6 + i * 7, 3, 3);
        }
      }
      x += w + random() * 6;
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

export class Sky {
  readonly group = new THREE.Group();
  private readonly disposables: { dispose: () => void }[] = [];
  private readonly clouds: THREE.Mesh;

  constructor(palette: SkyPalette, sunDir: THREE.Vector3, seed: number) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 32, 20),
      new THREE.ShaderMaterial({
        depthWrite: false,
        fragmentShader: FRAGMENT,
        side: THREE.BackSide,
        uniforms: {
          uHorizon: { value: new THREE.Color(palette.horizon) },
          uMid: { value: new THREE.Color(palette.mid) },
          uSun: { value: new THREE.Color(palette.sun) },
          uSunDir: { value: sunDir.clone() },
          uZenith: { value: new THREE.Color(palette.zenith) },
        },
        vertexShader: VERTEX,
      }),
    );
    dome.renderOrder = -4;
    dome.frustumCulled = false;
    this.keep(dome);

    const random = seeded(seed);
    const stars = new Float32Array(500 * 3);
    for (let i = 0; i < 500; i += 1) {
      const a = random() * Math.PI * 2;
      const up = 0.25 + random() * 0.75;
      const r = Math.sqrt(1 - up * up);
      stars.set([Math.cos(a) * r * 900, up * 900, Math.sin(a) * r * 900], i * 3);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(stars, 3));
    const points = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        color: "#dfe6ff",
        depthWrite: false,
        fog: false,
        opacity: 0.25,
        size: 1.5,
        sizeAttenuation: false,
        transparent: true,
      }),
    );
    points.renderOrder = -3;
    points.frustumCulled = false;
    this.keep(points);

    const cloudMap = cloudBands(seed);
    this.clouds = new THREE.Mesh(
      new THREE.CylinderGeometry(880, 880, 420, 48, 1, true),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(palette.sun).lerp(new THREE.Color("#ffffff"), 0.35),
        depthWrite: false,
        fog: false,
        map: cloudMap,
        opacity: 0.5,
        side: THREE.BackSide,
        transparent: true,
      }),
    );
    this.clouds.position.y = 230;
    this.clouds.renderOrder = -2;
    this.clouds.frustumCulled = false;
    this.disposables.push(cloudMap);
    this.keep(this.clouds);

    const skylineMap = skylineTexture(seed + 5);
    skylineMap.repeat.set(3, 1);
    const skyline = new THREE.Mesh(
      new THREE.CylinderGeometry(620, 620, 120, 64, 1, true),
      new THREE.MeshBasicMaterial({
        alphaTest: 0.5,
        color: palette.skyline,
        fog: false,
        map: skylineMap,
        side: THREE.BackSide,
        transparent: true,
      }),
    );
    skyline.position.y = 56;
    skyline.renderOrder = -1;
    this.disposables.push(skylineMap);
    this.keep(skyline);
  }

  update(time: number): void {
    this.clouds.rotation.y = time * 0.004;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const item of this.disposables) {
      item.dispose();
    }
  }

  private keep(object: THREE.Mesh | THREE.Points): void {
    this.disposables.push(object.geometry);
    if (!Array.isArray(object.material)) {
      this.disposables.push(object.material);
    }
    this.group.add(object);
  }
}

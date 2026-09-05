import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  createSalesforceModel,
  getSalesforceKit,
  setSalesforceNight,
} from "../../../src/world/sf-salesforce";

type View = "whole" | "lobby" | "crown" | "grid";
type Mode = "day" | "night" | "stripped";
declare global {
  interface Window {
    __salesforceReview: {
      view(view: View, mode?: Mode, angle?: number): void;
      shadows(enabled: boolean): void;
      readonly triangles: number;
      readonly meshCount: number;
    };
  }
}

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
const model = createSalesforceModel();
scene.add(model);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.4;
pmrem.dispose();
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(15, 50, 25);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -10;
key.shadow.camera.right = 10;
key.shadow.camera.top = 53;
key.shadow.camera.bottom = -5;
key.shadow.camera.far = 150;
key.shadow.bias = -0.0002;
key.shadow.normalBias = 0.035;
scene.add(key);
const fill = new THREE.HemisphereLight(0xe0f0fc, 0x81878b, 1.5);
scene.add(fill);
const groundMat = new THREE.MeshStandardMaterial({ color: 0xc5cbcc, roughness: 1 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.015;
ground.receiveShadow = true;
scene.add(ground);
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 300);
const matte = new THREE.MeshStandardMaterial({ color: 0xb5bcc0, roughness: 1, metalness: 0 });

function view(view: View, mode: Mode = "day", angle = 28): void {
  renderer.setSize(window.innerWidth, window.innerHeight);
  const centerY = view === "whole" ? 24.7 : view === "crown" ? 45.2 : view === "grid" ? 26 : 2.0;
  const height = view === "whole" ? 55 : view === "crown" ? 12 : view === "grid" ? 10 : 11;
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = (-height * aspect) / 2;
  camera.right = (height * aspect) / 2;
  camera.top = height / 2;
  camera.bottom = -height / 2;
  camera.updateProjectionMatrix();
  const a = (angle * Math.PI) / 180;
  camera.position.set(Math.sin(a) * 80, centerY + (view === "lobby" ? 10 : 7), Math.cos(a) * 80);
  camera.lookAt(0, centerY, 0);
  const night = mode === "night";
  scene.background = new THREE.Color(night ? 0x081327 : 0xcbd1d2);
  key.intensity = night ? 0.35 : 2.2;
  fill.intensity = night ? 0.65 : 1.5;
  scene.environmentIntensity = night ? 0.15 : 0.4;
  groundMat.color.setHex(night ? 0x26354a : 0xc5cbcc);
  setSalesforceNight(night ? 1 : 0);
  for (const [i, node] of model.children.entries()) {
    const part = getSalesforceKit()[i];
    if (node instanceof THREE.Mesh && part) node.material = mode === "stripped" ? matte : part.mat;
  }
  renderer.render(scene, camera);
}

window.__salesforceReview = {
  view,
  shadows(enabled: boolean): void {
    renderer.shadowMap.enabled = enabled;
    for (const part of getSalesforceKit()) part.mat.needsUpdate = true;
    matte.needsUpdate = true;
  },
  triangles: getSalesforceKit().reduce((sum, p) => sum + (p.geo.getIndex()?.count ?? 0) / 3, 0),
  meshCount: model.children.length,
};
view("whole");

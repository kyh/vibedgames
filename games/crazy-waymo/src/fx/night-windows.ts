import * as THREE from "three";

import { modelUrl, PROP_TRAFFICLIGHT } from "../assets/manifest";
import type { ModelCache } from "../assets/loader";
import { type Beacon, registerBeacons } from "./beacon-lights";
import type { BatchItemRec } from "../world/city";
import {
  BIG_SILHOUETTE_H,
  DETAIL_DISTANCE,
  IMPOSTER_DISTANCE,
  MID_IMPOSTER_DISTANCE,
  MID_SILHOUETTE_H,
} from "../world/city";
import { Rng } from "../shared/rng";

// Emissive night windows: the classic trick that makes a night city read
// ALIVE instead of merely visible. One static additive draw of lit-window
// quads generated on building facades from the batch-item records (solids
// don't carry heights — building boxes are "infinitely tall" for collision),
// ramped by the day-night lamp factor and faded out at the night fog line.
//
// Everything is baked in world space at build time: no per-frame work beyond
// two uniform writes, and the whole city is ONE draw call.
//
// THIS PASS ALSO OWNS THE STREET-LEVEL LIGHT DOWNTOWN, which is not where you
// would look for it. The batch-item records it is handed are the ONLY view of
// the finished city that carries both the buildings and the kerb hardware with
// their world matrices, and the measurement that started the last pass was
// this: within 120u of a Financial District chase camera the shipped world has
// ZERO street lamps and 79 signal-mast instances, while the same radius in the
// Richmond has 16 lamps and no signals. So the lit shop fronts here publish
// their spill onto the pavement, and the signal masts get the luminaire the
// lamp posts never could — both through the runtime beacon registry
// (fx/beacon-lights.ts), which GameScene drains after this constructor runs.
// See STREET-LEVEL LIGHT at the bottom of the file.

const MIN_HEIGHT = 7; // buildings shorter than this get no windows (sheds)
const FLOOR_STEP = 2.9; // world-space storey height
const COL_STEP = 2.3; // horizontal window spacing
const FACE_MARGIN = 1.1; // dead band at facade corners
const SILL_START = 2.0; // first storey sill height above the building base
const WIN_W = 0.62;
const WIN_H = 0.85;
const FACE_OFFSET = 0.09; // out from the wall so the quad never z-fights
// Fade out BEFORE the facade a window is painted on disappears — but the
// distance that happens at is PER BUILDING, and pinning every window to the
// shortest of those was costing the game its best image. city.ts culls in three
// tiers: full models to DETAIL_DISTANCE, ordinary buildings (MID_SILHOUETTE_H)
// as box imposters to MID_IMPOSTER_DISTANCE, skyline buildings
// (BIG_SILHOUETTE_H) as imposters all the way to IMPOSTER_DISTANCE. One global
// 240–360 fade meant that from Twin Peaks or the bay — SF at night, the single
// most recognisable image this game could own — the city below was an unlit
// black mass with a handful of pinpricks, while the towers it was drawn on were
// still standing there.
//
// An imposter box shares the real building's footprint, so a lit window sits on
// it correctly; each window just has to know which tier its own building is in.
//
// THE TIERS ARE IMPORTED, NOT COPIED. They used to be four private numbers here
// (360/590/860 against culls of 360/620/900), and when the streaming pass moved
// the real bands to 440/1100/1400 this file silently kept fading windows out at
// half the distance the box they sit on survives to. A window fades at
// FADE_END of its own building's cull, so the two can never drift again.
const FADE_END = 0.95; // windows are gone this far into their own building's cull
const FADE_RATIO = 0.66; // fade starts at this fraction of a window's own far

/** How far a window painted on a building this tall stays lit. */
function fadeFarFor(height: number): number {
  if (height >= BIG_SILHOUETTE_H) return IMPOSTER_DISTANCE * FADE_END;
  if (height >= MID_SILHOUETTE_H) return MID_IMPOSTER_DISTANCE * FADE_END;
  return DETAIL_DISTANCE;
}

// LIGHT IS CLUMPY, AND A UNIFORM SPRINKLE IS WHY THE CITY READ AS A BLACK MASS.
// The old pass lit a flat ~13% of every candidate pane everywhere, which from
// the bay is 31k pixels of noise spread so thin that no BUILDING reads as lit —
// only a faint speckle over a dark mass. Real cities clump: an office tower
// with the cleaners in runs 70% lit, the block next to it is dark, and the
// ground floor is the brightest thing on the street because that is where the
// shops are.
//
// So each building draws an OCCUPANCY from its own position hash and spends its
// share of the budget at that rate. The city-wide total is unchanged (the
// normalisation below still lands on `budget`); it is redistributed into
// buildings you can pick out at 600 metres.
// Bimodal on purpose: most blocks read as dark mass, and the ones that are on
// are ON. A gentler curve spends the same budget as an even speckle over the
// whole city, which is exactly the "black mass with a dusting of pinpricks" the
// gate measured from the bay.
const OCC_DARK = 0.06; // ceiling for the ~three quarters that are asleep
const OCC_LIT = 0.95;
const OCC_SPLIT = 0.68; // hash below this = a dark building
const MAX_P = 0.92; // no building is ever fully lit

// ...EXCEPT THAT A TOWER IS NOT A BLOCK OF FLATS. The position hash above is
// the right model for the residential fabric and the wrong one for downtown,
// and running it everywhere made the Financial District the DARKEST place in
// the city after dark: measured on the shipped world, 180 lit quads within
// 120u of a FiDi chase camera against 425 in the Richmond, 65 of them at
// street level against 417. An office block at 2am is the one building type
// that is reliably lit — cleaners, trading desks, the lobby, the floor nobody
// switches off — so height sets a FLOOR under the hash rather than replacing
// it. The hash still decides which of two neighbouring towers is the brighter.
const OFFICE_OCC_FLOOR = 0.5;
const OFFICE_TALL_LO = 16; // metres where the office floor starts to apply
const OFFICE_TALL_HI = 45; // …and where it is fully in

// LIGHT COMES IN FLOORS. A tower lit by an even per-pane sprinkle reads as
// static, not as a building: real office glass switches at the STOREY, so a
// third of the floors are dark bands and the rest are on almost end to end.
// The two multipliers below are deliberately mean-preserving (0.4*0.12 +
// 0.6*1.6 = 1.008) so banding redistributes a building's share of the budget
// without spending more of it than the census priced.
const BAND_DARK_SHARE = 0.4;
const BAND_DARK_MUL = 0.12;
const BAND_LIT_MUL = 1.6;

// THE GROUND FLOOR IS A SEPARATE BUDGET, NOT A WEIGHT. Shop fronts, lobbies and
// bar windows are the entire near read — at 10 metres on a low residential
// street they are the only light the block owns — and they do not care whether
// the flats upstairs are home. Bundling them into the occupancy weight made
// them inherit a dark building's near-zero probability, so the streets the
// player actually drives stayed unlit while the towers behind them glowed.
//
// A THIRD of buildings get a shop front, not all of them: a lit ground floor is
// what says "this corner is a bar and that one is a garage", and a city where
// every ground floor is on is a strip light, not a street. The split is by
// share of the total quad budget so the two reads (near street / distant
// skyline) can be tuned against each other without either starving.
const COMMERCIAL_SHARE = 0.44;
// A TOWER ALWAYS HAS A LOBBY. The flat 44% is a shopping-street rate; applied
// to the Financial District it left most of the podium wall — the only thing
// the player can see from a car down there — with no ground-floor light at
// all. An office building's ground floor is lit whether or not anyone is home
// upstairs, so the office bias pushes the share up toward certainty.
const LOBBY_BIAS = 0.8;
const SHOP_BUDGET_SHARE = 0.5;
// ONE ROW, in metres. The band has to be a real height and a tight one: a
// fraction of the building's glass span makes a tower's "ground floor" ten
// storeys tall, and a loose 4.5m band swallowed 226k of the city's 244k panes
// (most kit fabric is two storeys), which starved the flat rate down to 5% and
// left the streets as dark as before.
const SHOP_BAND = 2.2;
const SHOP_MAX_P = 0.75;

// THE CALLER'S BUDGET IS A QUAD CAP, AND IT WAS SET AS A COST CEILING RATHER
// THAN AS A LOOK. 32k lit panes over a 3172x2600 map is one lit window per
// ~250 square units, and the measurement that matters is the one at the top of
// this file: 180 lit quads within 120u of a downtown chase camera. The cost of
// the cap is not what it was — this is ONE draw of untextured additive quads,
// and 32k of them is 64k triangles in a frame that renders two million. The
// caller still owns the RATIO (mobile passes a smaller number and stays
// lighter); this owns the absolute level, which is a look decision and belongs
// with the rest of the look.
const BUDGET_GAIN = 2.2;

// Interior palette, by district and by what the building IS. Tungsten and
// sodium for the residential fabric, cool fluorescent for the office towers,
// the occasional TV-blue room, and a saturated shop-front warm for the ground
// floor. The temperature is not decoration: a night skyline reads as depth
// because the warm and the cool separate, and one colour of window is a
// streetlight-orange fog.
const TUNGSTEN = new THREE.Color(0xffb469);
const WARM = new THREE.Color(0xffd9a0);
const WARM2 = new THREE.Color(0xfff0c8);
const OFFICE = new THREE.Color(0xdcebff);
const COOL = new THREE.Color(0x9cc4ff);
const SHOPFRONT = new THREE.Color(0xffbe6a);
// Emissive gain. Pre-tonemap linear, these land between ~0.8 and ~1.9, which
// clears the night bloom threshold (render/post.ts NIGHT_BLOOM_THRESHOLD 0.62)
// and the grade's source mask (0.30) — so a lit window blooms and keeps its
// chroma while the city around it desaturates. The old 0.55..1.05 sat under
// both and rendered as a flat pale decal.
const GAIN_MIN = 0.8;
const GAIN_SPAN = 1.1;
const SHOP_GAIN = 1.55; // shop fronts are the brightest thing on the street
// Signage: one saturated accent over a fraction of the shop fronts. A night
// street is not lit in one temperature — the sign over the door is the only
// pure hue in the frame, and it is what tells you a dark block is a block of
// BUSINESSES rather than a wall. Kept rare on purpose; a neon on every unit is
// a strip, not a city.
// A SIGN IS A COMMERCIAL OBJECT. Hung off every lit ground floor it put neon
// on the front of the Richmond's houses — measured against the before frame,
// the single worst thing in the pass — so it is gated on the same office bias
// that decides a window's colour temperature: a shop or a lobby gets one, a
// two-storey stucco house never does.
const SIGN_OFFICE_MIN = 0.45;
const SIGN_SHARE = 0.34;
const SIGN_GAIN = 1.5;
const SIGN_COLORS: readonly THREE.Color[] = [
  new THREE.Color(0xff5a5a),
  new THREE.Color(0x6ad6ff),
  new THREE.Color(0xffc23d),
  new THREE.Color(0xff9d3d),
];

/** Deterministic 0..1 hash of a 2-D key. Used for per-building character. */
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * How much of this building is awake, 0..1. The position hash carries the
 * clumping (see the OCC_* note above); height raises the FLOOR under it, so a
 * downtown tower is never one of the dark ones. Passing height 0 gives the
 * pure residential curve.
 */
function occupancyAt(x: number, z: number, height: number): number {
  const h = hash2(Math.round(x * 0.37), Math.round(z * 0.37));
  const base =
    h < OCC_SPLIT
      ? OCC_DARK * (h / OCC_SPLIT)
      : 0.4 + (OCC_LIT - 0.4) * ((h - OCC_SPLIT) / (1 - OCC_SPLIT));
  const tall = THREE.MathUtils.smoothstep(height, OFFICE_TALL_LO, OFFICE_TALL_HI);
  return Math.max(base, OFFICE_OCC_FLOOR * tall);
}

/**
 * Per-STOREY multiplier on a building's lit chance — see the BAND_* note.
 * `seed` is the building's own hash so two towers never band in step.
 */
function bandMul(seed: number, floor: number): number {
  return hash2(seed * 37.1 + floor * 7.3, floor * 1.7 - seed * 5.9) < BAND_DARK_SHARE
    ? BAND_DARK_MUL
    : BAND_LIT_MUL;
}

/** 0 = warm residential district .. 1 = cool commercial district, ~240u cells. */
function districtCool(x: number, z: number): number {
  return hash2(Math.floor(x / 240), Math.floor(z / 240));
}

/**
 * Does this address have a lit ground floor tonight? Salted off occupancy, and
 * near-certain for an office building (see LOBBY_BIAS).
 */
function hasShopfront(x: number, z: number, office: number): boolean {
  const p = COMMERCIAL_SHARE + (1 - COMMERCIAL_SHARE) * office * LOBBY_BIAS;
  return hash2(Math.round(x * 0.41) + 91.7, Math.round(z * 0.41) - 57.3) < p;
}

/**
 * One window's colour. `office` blends district character with the building's
 * own height (towers are offices wherever they stand); `shop` overrides both.
 */
function windowColor(
  out: THREE.Color,
  rng: Rng,
  office: number,
  shop: boolean,
  gainScale: number,
): void {
  if (shop) {
    out.copy(SHOPFRONT);
  } else if (rng.chance(0.1 + 0.14 * office)) {
    out.copy(COOL); // a television, or one late fluorescent bay
  } else if (rng.chance(office)) {
    out.copy(OFFICE);
  } else {
    out.copy(rng.chance(0.55) ? TUNGSTEN : rng.chance(0.5) ? WARM : WARM2);
  }
  out.multiplyScalar((GAIN_MIN + rng.range(0, GAIN_SPAN)) * gainScale);
}

/**
 * Everything the emitters write into: the one additive mesh's vertex streams,
 * plus the street-level beacons the lit shop fronts throw onto the pavement.
 */
type Sink = {
  readonly positions: number[];
  readonly colors: number[];
  readonly fars: number[];
  /**
   * A soft halo over a share of the lit shop fronts. Deliberately NOT a pool
   * of light on the pavement: a shop front's height above the road is the one
   * thing this pass cannot know (a downtown kit block stands on a podium, so
   * its lowest glass is three metres up), and a flat pool drawn at a guessed
   * ground height reads as a sheet of light floating over the street. A halo
   * sits ON the glass that emits it and cannot be in the wrong place.
   */
  readonly shopGlow: Beacon[];
  /** Shared scratch colour — the emitters run over ~250k panes. */
  readonly scratch: THREE.Color;
};

type Instance = {
  cx: number;
  cz: number;
  baseY: number;
  hx: number;
  hz: number;
  height: number;
  yaw: number;
  /** 0..1 share of this building's windows that are lit tonight. */
  occ: number;
  /** 0..1 chance any given window uses office-white rather than tungsten. */
  office: number;
  /** Storeys lit as shop front (0 = no ground-floor business here). */
  shopFloors: number;
  /** Stable per-building salt for the floor banding. */
  seed: number;
};

export class NightWindows {
  readonly mesh: THREE.Mesh;
  private uNight = { value: 0 };

  constructor(items: readonly BatchItemRec[], cache: ModelCache, budget: number) {
    const rng = new Rng(20260709);
    // Real windows first: rectangles detected in each model's geometry (see
    // detectWindows) — lit quads land exactly ON the modelled glass. Models
    // where detection finds nothing fall back to the old procedural grid.
    const detected = collectDetected(items, cache);
    const instances = collectBuildings(detected.fallbackItems, cache);

    // Census first, in DEMAND rather than in candidates: an upper-storey pane
    // asks for its building's occupancy, a ground-floor one asks flat, and the
    // two scales below buy exactly `spend` of the pair. Scaling one flat
    // chance instead is what spread the light evenly over the whole city and
    // left no building lit and no street lit either.
    const spend = budget * BUDGET_GAIN;
    const census = { shop: detected.census.shop, upper: detected.census.upper };
    for (const b of instances) {
      const d = buildingDemand(b);
      census.shop += d.shop;
      census.upper += d.upper;
    }
    const scale = {
      shop: Math.min(SHOP_MAX_P, (spend * SHOP_BUDGET_SHARE) / Math.max(1, census.shop)),
      upper: Math.min(
        MAX_P / OCC_LIT,
        (spend * (1 - SHOP_BUDGET_SHARE)) / Math.max(1, census.upper),
      ),
    };

    const sink: Sink = {
      positions: [],
      colors: [],
      fars: [],
      shopGlow: [],
      scratch: new THREE.Color(),
    };
    emitDetected(detected, rng, scale, sink);
    for (const b of instances) {
      emitBuilding(b, rng, scale, sink);
    }
    const { positions, colors, fars } = sink;

    // Street-level light: the shop fronts' own glow plus a luminaire on the
    // signal masts. Both are beacons, not geometry — GameScene drains the
    // registry into one instanced additive draw once the world's tail resolves.
    const masts = mastLuminaires(items);
    registerBeacons("night-street", [...sink.shopGlow, ...masts]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute("aFar", new THREE.Float32BufferAttribute(fars, 1));
    geo.computeBoundingSphere();

    const mat = new THREE.ShaderMaterial({
      uniforms: { uNight: this.uNight },
      vertexShader: /* glsl */ `
        attribute vec3 color;
        attribute float aFar;
        varying vec3 vColor;
        varying float vFade;
        void main() {
          vColor = color;
          float d = distance(position, cameraPosition);
          vFade = 1.0 - smoothstep(aFar * ${FADE_RATIO.toFixed(2)}, aFar, d);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying vec3 vColor;
        varying float vFade;
        void main() {
          gl_FragColor = vec4(vColor * uNight * vFade, 1.0);
        }
      `,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      // Detected panes inherit each instance's matrix — a mirrored (negative
      // determinant) instance would flip their winding and FrontSide-cull
      // them. No kit ships mirrored buildings today; DoubleSide closes the
      // trap for ~zero cost (tiny quads, additive, depth-tested).
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "night-windows";
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 2; // after the city, with the other glow passes
    console.log(
      `[windows] ${positions.length / 18} lit windows on ${detected.instances.length}` +
        ` glazed + ${instances.length} procedural buildings (budget ${budget}x${BUDGET_GAIN};` +
        ` shop ${Math.round(census.shop)} cand @ p${scale.shop.toFixed(2)},` +
        ` upper ${Math.round(census.upper)} demand @ x${scale.upper.toFixed(2)});` +
        ` street: ${sink.shopGlow.length} shop glows + ${masts.length} mast luminaires`,
    );
  }

  setIntensity(night: number): void {
    this.uNight.value = night;
    this.mesh.visible = night > 0.02;
  }
}

// --- Detected windows: light the ACTUAL modelled glass -------------------
// The kits paint window glass as a desaturated dark blue via the shared
// colormap atlas. Per source mesh (cached by url|idx): sample each triangle's
// UV centroid in the colormap, keep the blue "glass" triangles, group them
// into panes by shared vertices (scale-free — quantized meshopt attributes
// make fixed-size clustering impossible), and store each pane as a local-
// space rect (center, horizontal tangent, width, height). Instances then
// place lit quads exactly on their windows. Models with no detectable glass
// fall back to the procedural grid below.

type Pane = {
  cx: number;
  cy: number;
  cz: number;
  tx: number; // horizontal tangent (local)
  tz: number;
  w: number;
  h: number;
};

type DetectedInstance = {
  m: Float32Array;
  panes: readonly Pane[];
  /** 0..1 share of this building's glass that is lit tonight. */
  occ: number;
  /** 0..1 chance a window here is office-white rather than tungsten. */
  office: number;
  /**
   * Model-space Y below which a pane counts as a shop front. -Infinity when
   * this address has no ground-floor business at all.
   */
  shopY: number;
  /** How far windows on this building stay lit (its imposter cull tier). */
  far: number;
  /** Model-space Y of the lowest glass, and one storey in model space. */
  loY: number;
  floorStep: number;
  /** Stable per-building salt for the floor banding. */
  seed: number;
};
/**
 * What the city is asking the budget for: ground-floor panes counted flat,
 * upper-storey panes weighted by their building's occupancy.
 */
type Census = { shop: number; upper: number };

/** The two probabilities the census resolves to. See the constructor. */
type LitScale = { readonly shop: number; readonly upper: number };

type Detected = {
  instances: DetectedInstance[];
  fallbackItems: BatchItemRec[];
  census: Census;
};

const imageDataCache = new Map<string, ImageData | null>();

function imageDataFor(tex: THREE.Texture): ImageData | null {
  const cached = imageDataCache.get(tex.uuid);
  if (cached !== undefined) return cached;
  let data: ImageData | null = null;
  const img: unknown = tex.image;
  if (
    img instanceof HTMLImageElement ||
    img instanceof ImageBitmap ||
    (globalThis.HTMLCanvasElement !== undefined && img instanceof HTMLCanvasElement)
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0);
      try {
        data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        data = null; // tainted canvas — fall back
      }
    }
  }
  imageDataCache.set(tex.uuid, data);
  return data;
}

// Window glass swatches: Kenney's bright blue (103,148,217) and KayKit's
// slate blue (77,107,130). Both tests must EXCLUDE the blue-grey walls
// (142,149,179 / 121,131,136) and navy trim (81,85,102) — a loose
// blue-dominance check matched entire facades.
function isGlassRgb(r: number, g: number, b: number): boolean {
  if (b > 160 && b > r * 1.35 && b > g * 1.25) return true; // Kenney
  return b >= 115 && b <= 155 && b > r * 1.55 && b > g * 1.15; // KayKit
}

const paneCache = new Map<string, readonly Pane[]>();

function detectPanes(url: string, idx: number, cache: ModelCache): readonly Pane[] {
  const key = `${url}|${idx}`;
  const cached = paneCache.get(key);
  if (cached) return cached;
  const out: Pane[] = [];
  paneCache.set(key, out);
  const mesh = cache.srcMesh(url, idx);
  if (!mesh || Array.isArray(mesh.material)) return out;
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  const mat = mesh.material;
  const map = mat instanceof THREE.MeshStandardMaterial ? mat.map : null;
  const img = map ? imageDataFor(map) : null;
  const flat =
    !img && mat instanceof THREE.MeshStandardMaterial
      ? isGlassRgb(mat.color.r * 255, mat.color.g * 255, mat.color.b * 255)
      : false;
  if (!img && !flat) return out;
  if (img && !uv) return out;

  const index = geo.index;
  const triCount = (index ? index.count : pos.count) / 3;
  if (triCount > 20000) return out;
  const vid = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);

  // Glass triangles + union-find by shared vertex index.
  const glassTris: number[] = [];
  const parent = new Map<number, number>(); // tri -> parent tri
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    let c = a;
    while (parent.get(c) !== c) {
      const n = parent.get(c) ?? c;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const vertOwner = new Map<number, number>();
  for (let t = 0; t < triCount; t++) {
    if (img) {
      let u = 0;
      let v = 0;
      for (let k = 0; k < 3; k++) {
        const i = vid(t, k);
        u += (uv?.getX(i) ?? 0) / 3;
        v += (uv?.getY(i) ?? 0) / 3;
      }
      u -= Math.floor(u);
      v -= Math.floor(v);
      const px = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)));
      const flipY = map ? map.flipY : false;
      const pyRaw = flipY ? 1 - v : v;
      const py = Math.min(img.height - 1, Math.max(0, Math.floor(pyRaw * img.height)));
      const o = (py * img.width + px) * 4;
      const r = img.data[o] ?? 0;
      const g = img.data[o + 1] ?? 0;
      const b = img.data[o + 2] ?? 0;
      if (!isGlassRgb(r, g, b)) continue;
    }
    // Steep faces only (skip skylight/roof glass) — cheap normal-Y test.
    const i0 = vid(t, 0);
    const i1 = vid(t, 1);
    const i2 = vid(t, 2);
    const e1x = pos.getX(i1) - pos.getX(i0);
    const e1y = pos.getY(i1) - pos.getY(i0);
    const e1z = pos.getZ(i1) - pos.getZ(i0);
    const e2x = pos.getX(i2) - pos.getX(i0);
    const e2y = pos.getY(i2) - pos.getY(i0);
    const e2z = pos.getZ(i2) - pos.getZ(i0);
    const nX = e1y * e2z - e1z * e2y;
    const nY = e1z * e2x - e1x * e2z;
    const nZ = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nX, nY, nZ) || 1;
    if (Math.abs(nY / nl) > 0.6) continue;
    glassTris.push(t);
    parent.set(t, t);
    for (const i of [i0, i1, i2]) {
      const owner = vertOwner.get(i);
      if (owner === undefined) vertOwner.set(i, t);
      else parent.set(find(t), find(owner));
    }
  }
  if (glassTris.length === 0 || glassTris.length > 4000) return out;

  // Pane rects per component, in the (tangent, Y) plane frame.
  type PaneAcc = {
    nx: number;
    nz: number;
    minU: number;
    maxU: number;
    minY: number;
    maxY: number;
    minD: number;
    maxD: number;
  };
  const accs = new Map<number, PaneAcc>();
  for (const t of glassTris) {
    const root = find(t);
    let a = accs.get(root);
    for (let k = 0; k < 3; k++) {
      const i = vid(t, k);
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (!a) {
        // Component normal from the first triangle (windows are planar).
        const i0 = vid(t, 0);
        const i1 = vid(t, 1);
        const i2 = vid(t, 2);
        const e1x = pos.getX(i1) - pos.getX(i0);
        const e1z = pos.getZ(i1) - pos.getZ(i0);
        const e2x = pos.getX(i2) - pos.getX(i0);
        const e2z = pos.getZ(i2) - pos.getZ(i0);
        const e1y = pos.getY(i1) - pos.getY(i0);
        const e2y = pos.getY(i2) - pos.getY(i0);
        let nx = e1y * e2z - e1z * e2y;
        let nz = e1x * e2y - e1y * e2x;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl;
        nz /= nl;
        a = {
          nx,
          nz,
          minU: Infinity,
          maxU: -Infinity,
          minY: Infinity,
          maxY: -Infinity,
          minD: Infinity,
          maxD: -Infinity,
        };
        accs.set(root, a);
      }
      const u = x * -a.nz + z * a.nx; // tangent coordinate
      const d = x * a.nx + z * a.nz; // plane depth
      if (u < a.minU) a.minU = u;
      if (u > a.maxU) a.maxU = u;
      if (y < a.minY) a.minY = y;
      if (y > a.maxY) a.maxY = y;
      if (d < a.minD) a.minD = d;
      if (d > a.maxD) a.maxD = d;
    }
  }
  for (const a of accs.values()) {
    const w = a.maxU - a.minU;
    const h = a.maxY - a.minY;
    if (w <= 0 || h <= 0) continue;
    const mu = (a.minU + a.maxU) / 2;
    const md = (a.maxD + a.minD) / 2;
    out.push({
      cx: -a.nz * mu + a.nx * md,
      cy: (a.minY + a.maxY) / 2,
      cz: a.nx * mu + a.nz * md,
      tx: -a.nz,
      tz: a.nx,
      w,
      h,
    });
  }
  return out;
}

function collectDetected(items: readonly BatchItemRec[], cache: ModelCache): Detected {
  const instances: DetectedInstance[] = [];
  const fallbackItems: BatchItemRec[] = [];
  const census: Census = { shop: 0, upper: 0 };
  // A model falls back only when NO mesh of its url has panes.
  const urlHasPanes = new Map<string, boolean>();
  for (const it of items) {
    if (it.url === null || !it.url.includes("/buildings/")) continue;
    const panes = detectPanes(it.url, it.idx, cache);
    if (panes.length > 0) {
      const inst = describeDetected(it.m, panes);
      instances.push(inst);
      for (const p of panes) {
        if (p.cy <= inst.shopY) census.shop += 1;
        else census.upper += inst.occ;
      }
      urlHasPanes.set(it.url, true);
    } else if (!urlHasPanes.has(it.url)) {
      urlHasPanes.set(it.url, false);
    }
  }
  for (const it of items) {
    if (it.url === null || !it.url.includes("/buildings/")) continue;
    if (!urlHasPanes.get(it.url)) fallbackItems.push(it);
  }
  return { instances, fallbackItems, census };
}

/**
 * Everything about a glazed building that is the same for all of its panes:
 * where it stands (occupancy + district temperature), how tall its glass runs
 * (cull tier, and where the shop-front band ends), all derived once.
 *
 * The vertical span of the glass is the only height signal a detected building
 * has — panes carry no bbox — and it answers both questions the emitter asks:
 * which imposter tier survives out there, and where the ground floor stops.
 * The instance matrix carries the kit's scale, so the span goes through its Y
 * basis vector before it means metres.
 */
function describeDetected(m: Float32Array, panes: readonly Pane[]): DetectedInstance {
  let loY = Infinity;
  let hiY = -Infinity;
  for (const p of panes) {
    if (p.cy - p.h / 2 < loY) loY = p.cy - p.h / 2;
    if (p.cy + p.h / 2 > hiY) hiY = p.cy + p.h / 2;
  }
  const span = hiY > loY ? hiY - loY : 0;
  const sy = Math.hypot(m[4] ?? 0, m[5] ?? 1, m[6] ?? 0);
  const height = span * sy + SILL_START;
  const x = m[12] ?? 0;
  const z = m[14] ?? 0;
  const office = officeBiasFor(height, districtCool(x, z));
  return {
    m,
    panes,
    occ: occupancyAt(x, z, height),
    office,
    // SHOP_BAND is metres, so it goes through the kit's scale to reach model
    // space — a fraction of the span instead would make a tower's "ground
    // floor" ten storeys tall and a cottage's half its facade.
    shopY: hasShopfront(x, z, office)
      ? loY + Math.min(span, SHOP_BAND / Math.max(0.01, sy))
      : -Infinity,
    far: fadeFarFor(height),
    loY,
    floorStep: FLOOR_STEP / Math.max(0.01, sy),
    seed: hash2(Math.round(x * 0.13), Math.round(z * 0.13)),
  };
}

/**
 * Office-white vs tungsten. Height dominates — anything over ~4 storeys is
 * commercial wherever it stands — with the district hash breaking the tie for
 * the low fabric so the Sunset stays warm and SoMa doesn't.
 */
function officeBiasFor(height: number, cool: number): number {
  const tall = THREE.MathUtils.smoothstep(height, 12, 34);
  return Math.min(0.95, tall * 0.75 + cool * 0.3);
}

const M4 = new THREE.Matrix4();
const CORNERS = [
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
];
const EDGE_A = new THREE.Vector3();
const EDGE_B = new THREE.Vector3();
const NORMAL = new THREE.Vector3();

function emitDetected(det: Detected, rng: Rng, scale: LitScale, sink: Sink): void {
  const { positions, colors, fars, scratch } = sink;
  for (const inst of det.instances) {
    M4.fromArray(inst.m);
    const far = inst.far;
    const upperP = Math.min(MAX_P, inst.occ * scale.upper);
    for (const p of inst.panes) {
      const shop = p.cy <= inst.shopY;
      // Upper storeys switch by FLOOR (see BAND_*); the ground floor is its
      // own budget and never bands — a lit shop next to a dark one is the
      // rhythm of a street, a lit shop BAND is a shopping centre.
      const floor = Math.floor((p.cy - inst.loY) / Math.max(0.01, inst.floorStep));
      const p0 = shop ? scale.shop : Math.min(MAX_P, upperP * bandMul(inst.seed, floor));
      if (!rng.chance(p0)) continue;
      // Inset 8% so the glow sits inside the frame; shop fronts fill their
      // glass instead — a lobby window is lit corner to corner.
      const inset = shop ? 1.0 : 0.92;
      const hw = (p.w / 2) * inset;
      const hh = (p.h / 2) * inset;
      const c0 = CORNERS[0];
      const c1 = CORNERS[1];
      const c2 = CORNERS[2];
      const c3 = CORNERS[3];
      if (!c0 || !c1 || !c2 || !c3) continue;
      c0.set(p.cx + p.tx * hw, p.cy - hh, p.cz + p.tz * hw).applyMatrix4(M4);
      c1.set(p.cx - p.tx * hw, p.cy - hh, p.cz - p.tz * hw).applyMatrix4(M4);
      c2.set(p.cx - p.tx * hw, p.cy + hh, p.cz - p.tz * hw).applyMatrix4(M4);
      c3.set(p.cx + p.tx * hw, p.cy + hh, p.cz + p.tz * hw).applyMatrix4(M4);
      // World normal from the transformed rect; lift the quad off the glass.
      EDGE_A.subVectors(c1, c0);
      EDGE_B.subVectors(c3, c0);
      NORMAL.crossVectors(EDGE_A, EDGE_B).normalize().multiplyScalar(FACE_OFFSET);
      c0.add(NORMAL);
      c1.add(NORMAL);
      c2.add(NORMAL);
      c3.add(NORMAL);
      positions.push(c0.x, c0.y, c0.z, c1.x, c1.y, c1.z, c2.x, c2.y, c2.z);
      positions.push(c0.x, c0.y, c0.z, c2.x, c2.y, c2.z, c3.x, c3.y, c3.z);
      windowColor(scratch, rng, inst.office, shop, shop ? SHOP_GAIN : 1);
      for (let v = 0; v < 6; v++) {
        colors.push(scratch.r, scratch.g, scratch.b);
        fars.push(far);
      }
      if (!shop) continue;
      // Ground floor only: the halo that makes the glass read as a SOURCE, and
      // the sign over the door. Both use the pane's own world frame — c0..c3
      // run bottom-right, bottom-left, top-left, top-right around it.
      const cx = (c0.x + c2.x) / 2;
      const cy = (c0.y + c2.y) / 2;
      const cz = (c0.z + c2.z) / 2;
      const width = Math.hypot(c1.x - c0.x, c1.z - c0.z);
      const top = c2.y;
      SHOP.set(cx, cy, cz);
      TANGENT.set(c1.x - c0.x, 0, c1.z - c0.z).normalize();
      pushShopGlow(sink, rng, SHOP, NORMAL, width);
      pushSign(sink, rng, SHOP, TANGENT, NORMAL, width, top, far, inst.office);
    }
  }
}

// One soft halo in front of a lit shop window, and one sign over it. Both are
// emitted from the pane's WORLD rect, so the two facade paths (detected glass /
// procedural grid) share them by handing over the same three corners.
// The halo is a BLEED off the glass, not a lamp: at 4.5u it read as a row of
// fat bokeh orbs hanging in front of the shops rather than as light coming out
// of them. It stays smaller than the window it belongs to.
//
// And it stays RARE, because it is the one thing in this pass that costs real
// frame time: an additive billboard is fill, the layer has no per-instance
// cull, and the night bloom already gives every lit pane a glow of its own —
// so the halo is only there to make the shops that anchor a block read as
// sources. Measured, chase height: at share 0.26 (9.2k halos) the three sites
// lost 12–17% of their frame rate; at 0.10 the same sites are within 6%.
const SHOP_GLOW_SHARE = 0.1;
const SHOP_GLOW_COLOR = 0xffb877;
const SHOP_GLOW_SIZE = 1.7;
const SIGN_H = 0.45; // sign band height in world units
const SIGN_HALF_MAX = 1.1; // …and half-width cap: a fascia, not a billboard
const SIGN_RISE = 0.6; // above the top of the glass
const SIGN_OUT = 2.4; // multiples of FACE_OFFSET, proud of the wall
// A sign is a small object: past ~300u it is one sub-pixel dot of pure hue,
// which is exactly the speckle the last pass spent its effort removing from
// the far read. It leaves the frame well before the window it hangs over does.
const SIGN_FAR = 300;

const SHOP = new THREE.Vector3();
const TANGENT = new THREE.Vector3();

/** Soft halo in front of a lit shop window — see Sink.shopGlow. */
function pushShopGlow(
  sink: Sink,
  rng: Rng,
  at: THREE.Vector3,
  normal: THREE.Vector3,
  width: number,
): void {
  if (!rng.chance(SHOP_GLOW_SHARE)) return;
  // `normal` arrives scaled to FACE_OFFSET, so a few multiples of it hang the
  // halo clear of the wall it is lighting without another normalize.
  const k = 5;
  sink.shopGlow.push({
    x: at.x + normal.x * k,
    y: at.y,
    z: at.z + normal.z * k,
    color: SHOP_GLOW_COLOR,
    size: SHOP_GLOW_SIZE * THREE.MathUtils.clamp(width, 0.6, 1.7),
  });
}

/** The sign over the door: one saturated accent band on a COMMERCIAL facade. */
function pushSign(
  sink: Sink,
  rng: Rng,
  at: THREE.Vector3,
  tangent: THREE.Vector3,
  normal: THREE.Vector3,
  width: number,
  top: number,
  far: number,
  office: number,
): void {
  if (office < SIGN_OFFICE_MIN || !rng.chance(SIGN_SHARE)) return;
  const hw = THREE.MathUtils.clamp(width * 0.42, 0.35, SIGN_HALF_MAX);
  const ox = at.x + normal.x * SIGN_OUT;
  const oz = at.z + normal.z * SIGN_OUT;
  const y0 = top + SIGN_RISE;
  const y1 = y0 + SIGN_H;
  const ax = ox + tangent.x * hw;
  const az = oz + tangent.z * hw;
  const bx = ox - tangent.x * hw;
  const bz = oz - tangent.z * hw;
  sink.positions.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
  sink.scratch.copy(rng.pick(SIGN_COLORS)).multiplyScalar(SIGN_GAIN);
  for (let v = 0; v < 6; v++) {
    sink.colors.push(sink.scratch.r, sink.scratch.g, sink.scratch.b);
    sink.fars.push(Math.min(far, SIGN_FAR));
  }
}

// One record per building INSTANCE. Batch items are per source MESH with the
// child-node transform baked into the matrix, so a building is several items
// whose translations differ (roof pieces sit high). Grouping on (url, rounded
// x/z) and UNIONING each mesh's actual world-space bbox — expressed in the
// instance's yaw frame so rotated avenue buildings keep tight facades — gives
// the real building box. (Whole-model bounds at a child matrix put windows in
// the sky over multi-node models.)
type Acc = {
  yaw: number;
  sin: number;
  cos: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

function collectBuildings(items: readonly BatchItemRec[], cache: ModelCache): Instance[] {
  const acc = new Map<string, Acc>();
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const corner = new THREE.Vector3();
  for (const it of items) {
    if (it.url === null || !it.url.includes("/buildings/")) continue;
    const srcMesh = cache.srcMesh(it.url, it.idx);
    if (!srcMesh) continue;
    const geo = srcMesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) continue;
    m4.fromArray(it.m);
    m4.decompose(pos, quat, scl);
    // Buildings rotate about Y only; anything tilted isn't a facade.
    if (Math.abs(quat.x) > 1e-3 || Math.abs(quat.z) > 1e-3) continue;
    const yaw = 2 * Math.atan2(quat.y, quat.w);
    const key = `${it.url}|${Math.round(pos.x / 2)}|${Math.round(pos.z / 2)}`;
    let a = acc.get(key);
    if (!a) {
      a = {
        yaw,
        sin: Math.sin(yaw),
        cos: Math.cos(yaw),
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
      };
      acc.set(key, a);
    }
    // 8 bbox corners → world → the instance's yaw-local frame.
    for (let i = 0; i < 8; i++) {
      corner
        .set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
        .applyMatrix4(m4);
      const lx = corner.x * a.cos - corner.z * a.sin;
      const lz = corner.x * a.sin + corner.z * a.cos;
      if (lx < a.minX) a.minX = lx;
      if (lx > a.maxX) a.maxX = lx;
      if (corner.y < a.minY) a.minY = corner.y;
      if (corner.y > a.maxY) a.maxY = corner.y;
      if (lz < a.minZ) a.minZ = lz;
      if (lz > a.maxZ) a.maxZ = lz;
    }
  }
  const out: Instance[] = [];
  for (const a of acc.values()) {
    const height = a.maxY - a.minY;
    const hx = (a.maxX - a.minX) / 2;
    const hz = (a.maxZ - a.minZ) / 2;
    // Skip sheds and anything implausibly wide for a single building.
    if (height < MIN_HEIGHT || hx > 40 || hz > 40 || hx < 1 || hz < 1) continue;
    const lcx = (a.minX + a.maxX) / 2;
    const lcz = (a.minZ + a.maxZ) / 2;
    // Yaw-local centre back to world (inverse of the rotation above).
    const cx = lcx * a.cos + lcz * a.sin;
    const cz = -lcx * a.sin + lcz * a.cos;
    const office = officeBiasFor(height, districtCool(cx, cz));
    out.push({
      cx,
      cz,
      baseY: a.minY,
      hx,
      hz,
      height,
      yaw: a.yaw,
      occ: occupancyAt(cx, cz, height),
      office,
      shopFloors: hasShopfront(cx, cz, office) ? SHOP_FLOORS : 0,
      seed: hash2(Math.round(cx * 0.13), Math.round(cz * 0.13)),
    });
  }
  return out;
}

function gridFor(b: Instance) {
  return {
    floors: Math.max(0, Math.floor((b.height - SILL_START - 1.0) / FLOOR_STEP)),
    colsX: Math.max(0, Math.floor((b.hx * 2 - FACE_MARGIN * 2) / COL_STEP)),
    colsZ: Math.max(0, Math.floor((b.hz * 2 - FACE_MARGIN * 2) / COL_STEP)),
  };
}

/** This building's share of the two budgets — the fallback twin of the census. */
function buildingDemand(b: Instance): Census {
  const g = gridFor(b);
  const cols = (g.colsX + g.colsZ) * 2;
  const shopFloors = Math.min(g.floors, b.shopFloors);
  return {
    shop: cols * shopFloors,
    upper: b.occ * cols * (g.floors - shopFloors),
  };
}

// Storeys the procedural grid treats as shop front. Its floors are explicit
// (unlike the detected panes' metric band), so the ground floor is just floor 0
// — one lit band at street level, which is the whole near read.
const SHOP_FLOORS = 1;

function emitBuilding(b: Instance, rng: Rng, scale: LitScale, sink: Sink): void {
  const { positions, colors, fars, scratch } = sink;
  const g = gridFor(b);
  if (g.floors === 0) return;
  const far = fadeFarFor(b.height);
  const sin = Math.sin(b.yaw);
  const cos = Math.cos(b.yaw);
  // Four faces in the building's LOCAL frame: (normal, tangent, half-extents).
  const faces: readonly { nx: number; nz: number; cols: number; half: number }[] = [
    { nx: 0, nz: 1, cols: g.colsX, half: b.hz },
    { nx: 0, nz: -1, cols: g.colsX, half: b.hz },
    { nx: 1, nz: 0, cols: g.colsZ, half: b.hx },
    { nx: -1, nz: 0, cols: g.colsZ, half: b.hx },
  ];
  for (const f of faces) {
    if (f.cols === 0) continue;
    // Tangent runs left along the face when looking at it from outside.
    const tx = -f.nz;
    const tz = f.nx;
    const span = (f.cols - 1) * COL_STEP;
    for (let fl = 0; fl < g.floors; fl++) {
      const y = b.baseY + SILL_START + fl * FLOOR_STEP;
      const shop = fl < b.shopFloors;
      // Upper storeys switch by FLOOR, the ground floor unit by unit — the
      // same split emitDetected makes, for the same reason.
      const p = shop ? scale.shop : Math.min(MAX_P, b.occ * scale.upper * bandMul(b.seed, fl));
      for (let c = 0; c < f.cols; c++) {
        if (!rng.chance(p)) continue;
        const along = -span / 2 + c * COL_STEP;
        // Local-frame window centre, pushed out of the wall.
        const lx = f.nx * (f.nx !== 0 ? b.hx + FACE_OFFSET : 0) + tx * along;
        const lz = f.nz * (f.nz !== 0 ? b.hz + FACE_OFFSET : 0) + tz * along;
        // Local → world (rotate by yaw about the box centre).
        const wx = b.cx + lx * cos + lz * sin;
        const wz = b.cz - lx * sin + lz * cos;
        const wtx = tx * cos + tz * sin;
        const wtz = -tx * sin + tz * cos;
        // Shop fronts are wider and shorter than the flats above them — that
        // proportion alone is what makes the ground floor read as commercial
        // from a car rather than as one more row of the same window.
        const hw = (shop ? WIN_W * 1.75 : WIN_W) / 2;
        // Two triangles, CCW facing outward (backface-culled from inside).
        const ax = wx + wtx * hw;
        const az = wz + wtz * hw;
        const bx = wx - wtx * hw;
        const bz = wz - wtz * hw;
        const y0 = y;
        const y1 = y + (shop ? WIN_H * 1.25 : WIN_H);
        positions.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
        windowColor(scratch, rng, b.office, shop, shop ? SHOP_GAIN : 1);
        for (let v = 0; v < 6; v++) {
          colors.push(scratch.r, scratch.g, scratch.b);
          fars.push(far);
        }
        if (!shop) continue;
        // Ground floor: halo + sign, off the same frame the quad was built in.
        // The face normal is the local (nx, nz) turned by the building's yaw,
        // scaled to FACE_OFFSET so pushShopGlow/pushSign can step out in
        // multiples of it exactly as they do on the detected path.
        SHOP.set(wx, (y0 + y1) / 2, wz);
        TANGENT.set(wtx, 0, wtz);
        NORMAL.set(
          (f.nx * cos + f.nz * sin) * FACE_OFFSET,
          0,
          (-f.nx * sin + f.nz * cos) * FACE_OFFSET,
        );
        pushShopGlow(sink, rng, SHOP, NORMAL, hw * 2);
        pushSign(sink, rng, SHOP, TANGENT, NORMAL, hw * 2, y1, far, b.office);
      }
    }
  }
}

// --- STREET-LEVEL LIGHT: the luminaire on the signal mast ----------------
//
// DOWNTOWN HAS NO STREETLIGHTS, and no amount of tuning the ones it has can
// change that. world/furniture.ts walks every network edge and tries to seat a
// lamp post 0.6u outside the kerb; where the buildings meet the lot line —
// which is the definition of a downtown block — that lands inside a wall, the
// seat is refused, and the district ships unlit. Measured on the shipped
// world: 0 lamp heads within 100u of a Financial District chase camera, 11
// within 200u, against 16 within 120u in the Richmond, which is the district
// that reads correctly at night. Moving the lamps is a furniture change and a
// world rebake; this is the runtime half.
//
// What downtown does have is JUNCTION HARDWARE — 79 signal-mast instances
// inside the same 120u — and a signal mast carrying the street luminaire is
// what a real downtown corner looks like. So the light goes on the pole that
// is already standing there: a small hot head at the top of the mast and a
// pool wide enough to cross the roadway under it. Every lamp in this pass has
// real geometry beneath it; none of them floats.
//
// Density follows junction density, which is exactly the gradient we want —
// dense downtown, none in the residential grid where the lamp posts already
// work (the Richmond has no signals at all inside 120u, so this pass leaves
// the district that already reads correctly completely untouched).
const SIGNAL_URL = modelUrl("props", PROP_TRAFFICLIGHT);
const MAST_LIT_SHARE = 0.7; // not EVERY corner: four lit poles per junction is a forecourt
const MAST_HEAD_H = 4.9; // top of the 5u mast (world/furniture.ts scaleToHeight)
const MAST_COLOR = 0xffc98a;
const MAST_HALO = 1.5; // near fx/lamp-glow.ts HALO_SIZE; bigger reads as bokeh
const MAST_POOL = 13; // under fx/lamp-glow.ts POOL_SIZE: four pools at a junction must stay
// four pools. At 17 they merged into one wide smear of light across the crossing.
const MAST_POOL_BOOST = 1.9; // the beacon layer's house gain is tuned for deck lanterns
const MAST_GROUND_LIFT = 0.05;

/**
 * One luminaire per signal mast. Batch items are per source MESH, so a single
 * pole arrives as several records at slightly different child transforms —
 * they are grouped on a 2u cell and the group's LOWEST record is the pole's
 * seat on the pavement.
 */
function mastLuminaires(items: readonly BatchItemRec[]): Beacon[] {
  const posts = new Map<string, { x: number; y: number; z: number }>();
  for (const it of items) {
    if (it.url !== SIGNAL_URL) continue;
    const x = it.m[12] ?? 0;
    const y = it.m[13] ?? 0;
    const z = it.m[14] ?? 0;
    const key = `${Math.round(x / 2)}|${Math.round(z / 2)}`;
    const prev = posts.get(key);
    if (!prev) posts.set(key, { x, y, z });
    else if (y < prev.y) posts.set(key, { x, y, z });
  }
  const out: Beacon[] = [];
  for (const p of posts.values()) {
    if (hash2(Math.round(p.x * 0.5) + 13.3, Math.round(p.z * 0.5) - 7.1) > MAST_LIT_SHARE) continue;
    out.push({
      x: p.x,
      y: p.y + MAST_HEAD_H,
      z: p.z,
      color: MAST_COLOR,
      size: MAST_HALO,
      groundY: p.y + MAST_GROUND_LIFT,
      poolSize: MAST_POOL,
      poolBoost: MAST_POOL_BOOST,
    });
  }
  return out;
}

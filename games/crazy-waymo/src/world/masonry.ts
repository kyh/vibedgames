import * as THREE from "three";

// CUT STONE — the world's masonry vocabulary, in one place.
//
// WHY THIS IS GEOMETRY AND NOT A SHADER. Every other near-camera surface in
// this game gets its texture from a runtime `onBeforeCompile` on a shared
// module-scope material: `roads.ts applyAsphaltSpeckle`, `ground.ts
// applyGrassMottle`, `freeways.ts applyConcreteWeathering`. Those three all
// sit on builders that are re-run on BOTH load paths, so the shader reaches
// the shipped world. The stone masses do not: `buildGoldenGate` runs on cold
// generation only and its meshes ship inside `rest.bin`, and the baked path
// (`city.ts rebuildRest` → `materialFactory`) reconstructs a material from the
// serialized `MatRec` descriptor — colour, roughness, metalness, blending.
// A shader hook is not in that descriptor and does not survive. MEASURED: a
// `STONE.onBeforeCompile` that paints every fragment pure red leaves the
// anchorage stone-grey in a dev tab loading the bins. Only ROAD materials come
// back onto their live module-scope originals, and only because `roads.ts
// roadCollapseTarget` re-resolves them by colour.
//
// What DOES survive the round trip is geometry (position / normal / uv /
// index) and a flat material colour. So the masonry vocabulary is written in
// those: relief for the joints, a small palette of flat tones for the
// weathering. It costs zero shader instructions — which is also the right
// answer for a phone — and it renders identically on both load paths.
//
// The vocabulary itself is the same one the concrete shader speaks, and
// deliberately shares its numbers (see WEATHER below): a fixed WORLD-scale
// feature rhythm, value-only articulation held inside ±25%, nothing read as a
// texture and everything felt as a surface.

/**
 * The value ladder every stone surface is drawn from. `face` is the reference
 * tone — a hair off the shore's own grey — and the rest are steps around it, so
 * swapping the old flat material for this palette does not move the family's
 * mean value and cannot disturb the measured district/sky value ordering.
 *
 * Each entry is one material, i.e. one global BatchedMesh bucket — six draw
 * calls for every stone mass in the world, where the flat block it replaces
 * cost two.
 *
 * EVERY TONE HERE MUST KEEP A COLOUR NO OTHER MATERIAL IN THE WORLD USES.
 * This is CLAUDE.md's road-decal rule one level up: on the baked round trip a
 * material is nothing but its descriptor (colour, roughness, metalness, blend
 * flags), so `city.ts`'s material factory hands TWO builders that happen to
 * agree on all of it the SAME material object. `face` shipped at the seawall
 * lip's exact 0x9aa2a6/roughness 1 and was deduped onto it, which put one
 * material on two BatchedMeshes with different batch state — three then
 * recompiles between them every frame and one of the two draws BLACK. Measured:
 * the Golden Gate anchorage's `face` stones rendered as pure-black rectangles
 * from the standard Presidio chase framing (and only from cameras that also
 * held a stretch of seawall), while the other five tones were correct. Cloning
 * the material object cleared it with no other change. 0x9ba3a7 is one step off
 * the shore grey — visually the same stone, and its own material.
 */
export const MASONRY = {
  /** The reference ashlar face. */
  face: new THREE.MeshStandardMaterial({ color: 0x9ba3a7, roughness: 1 }),
  /** A block from a paler bed of the same quarry. */
  light: new THREE.MeshStandardMaterial({ color: 0xa5adb0, roughness: 1 }),
  /** ...and a darker one. */
  dark: new THREE.MeshStandardMaterial({ color: 0x8e969b, roughness: 1 }),
  /** Up-facing ledges: sun-bleached, and the only surface rain actually
   *  washes clean. */
  wash: new THREE.MeshStandardMaterial({ color: 0xafb5b6, roughness: 1 }),
  /** Recessed bed joints and every down-facing return. Carries the ambient
   *  occlusion the flat lighting will not give a 0.07u reveal on its own. */
  shade: new THREE.MeshStandardMaterial({ color: 0x767e83, roughness: 1 }),
  /** Drip staining under a cornice, and the damp at the foot of a wall. */
  stain: new THREE.MeshStandardMaterial({ color: 0x848780, roughness: 1 }),
} as const;

export type MasonryTone = keyof typeof MASONRY;

/**
 * Feature sizes and value amplitudes, shared with the cast-concrete shader in
 * `freeways.ts` so the two surfaces are the same material family seen at two
 * scales rather than two dialects. A viaduct's form-board seam and a bridge
 * abutment's bed joint are the same kind of fact about how the thing was
 * built, and they should be the same size and carry the same weight.
 */
export const WEATHER = {
  /** Nominal bed-course height. The concrete shader's form-board seams run at
   *  0.62u; masonry courses are the coarser rhythm of the same idea. */
  courseH: 0.78,
  /** Nominal stone length along a face (perpend pitch). */
  stoneLen: 1.7,
  /** Depth of a recessed bed joint, and the height of its reveal. */
  jointDepth: 0.075,
  jointHeight: 0.11,
  /** Chamfer cut off every vertical arris. A stone block with a mathematically
   *  sharp corner is the single loudest "this is a primitive" tell; the real
   *  ones are always arris-cut, and the cut catches its own highlight. */
  chamfer: 0.16,
  /** How far a drip stain runs down from under a cornice, in world units. The
   *  concrete shader's exponential streak decays over 3.2u; same number. */
  dripRun: 3.2,
  /** ...and how far the damp climbs from the foot of a wall. */
  dampRise: 1.6,
  /** Peak share of stones that take the stain tone directly under a drip line. */
  stainShare: 0.5,
  // --- Value amplitudes. The masonry palette above is cut to these, and the
  // cast-concrete shader in freeways.ts multiplies by them directly, so "how
  // dark is a joint" is one number for the whole material family.
  /** Darkening of a joint / seam line against the face it cuts. */
  jointValue: 0.18,
  /** Peak darkening of a drip streak directly under the edge that sheds it. */
  dripValue: 0.24,
  /** Peak-to-peak aggregate speckle. Felt, never read. */
  grainValue: 0.05,
} as const;

// THERE IS DELIBERATELY NO OUT-OF-PLANE JITTER PER STONE, and the reason is
// worth keeping: setting each block a hair proud of its neighbours is what real
// ashlar does, and it was built and shipped into a test bake. But a mass here
// is a hollow shell, so two faces meeting at a corner with different offsets no
// longer share their corner edge — every vertical arris opened a sliver
// straight through the block to whatever was behind it (measured at 3u on the
// Golden Gate anchorage: the bridge's orange truss showing through the stone,
// ~7 pixels wide). Any future "per-stone relief" idea has to close the corner
// first. The tone mosaic carries that read instead.

/** Deterministic 0..1 hash — world generation must not consume Math.random. */
function hash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** A plan outline: closed loop of (x, z) offsets from the block's own centre. */
type Outline = readonly (readonly [number, number])[];

/**
 * Rectangle with its four vertical arrises cut off, wound so that the outward
 * normal of edge (a → b) is `(dz, -dx)`. The chamfers are real faces: they are
 * what stops a 22u prism reading as a box, and they cost four quads a course.
 */
function chamferedPlan(hx: number, hz: number, c: number): Outline {
  const cx = Math.min(c, hx * 0.4);
  const cz = Math.min(c, hz * 0.4);
  return [
    [hx, -hz + cz],
    [hx, hz - cz],
    [hx - cx, hz],
    [-hx + cx, hz],
    [-hx, hz - cz],
    [-hx, -hz + cz],
    [-hx + cx, -hz],
    [hx - cx, -hz],
  ];
}

/**
 * One horizontal layer of the mass. A block is a STACK of these and nothing
 * else: the coursing is stone rings alternating with recessed joint rings, and
 * a cornice is three more rings with positive outsets. One emitter covers
 * ashlar, bed joints, string courses, plinths and cornice mouldings, which is
 * why none of them can drift out of the same vocabulary.
 */
type Ring = {
  /** Signed offset of every face from the shaft outline, in world units. */
  readonly outset: number;
  readonly h: number;
  /** `stone` splits its faces into individual blocks; the rest run continuous. */
  readonly kind: "stone" | "joint" | "trim";
};

type Sink = Map<MasonryTone, { pos: number[]; nor: number[] }>;

function sinkFor(sink: Sink, tone: MasonryTone): { pos: number[]; nor: number[] } {
  let s = sink.get(tone);
  if (!s) sink.set(tone, (s = { pos: [], nor: [] }));
  return s;
}

type P3 = readonly [number, number, number];

/**
 * Non-indexed triangle, flat-shaded off its own winding: the face is visible
 * from the side its vertices run counter-clockwise around. Everything below is
 * single-sided, so a reversed winding is an invisible face and a hole into the
 * inside of the mass — check the winding, not the geometry, when one appears.
 */
function tri(sink: Sink, tone: MasonryTone, a: P3, b: P3, c: P3): void {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-9) return; // degenerate: a zero-length stone or a collapsed ring
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const s = sinkFor(sink, tone);
  for (const p of [a, b, c]) {
    s.pos.push(p[0], p[1], p[2]);
    s.nor.push(nx, ny, nz);
  }
}

/** Planar quad (a, b, c, d) wound the same way as `tri`. */
function quad(sink: Sink, tone: MasonryTone, a: P3, b: P3, c: P3, d: P3): void {
  tri(sink, tone, a, b, c);
  tri(sink, tone, a, c, d);
}

/**
 * A stone mass, drawn as engineered masonry: coursed ashlar with recessed bed
 * joints, chamfered arrises, per-block tone off the same quarry, drip staining
 * under the overhang and damp at the foot — and, when asked for, a cornice that
 * is a PROFILE (fillet, projecting corona, cap) rather than a band.
 *
 * The mass is centred on (0, 0) in plan and SITS ON y = 0, so a caller seats it
 * exactly the way it seats a kit model. Returns a group of one mesh per tone;
 * position the GROUP, never the children.
 *
 * `batter` is the classic abutment lean: the plan shrinks by this fraction of
 * the mass's own half-width over its full height. It is what tells the eye
 * this thing is holding something back.
 */
export function masonryBlock(opts: {
  readonly w: number;
  readonly d: number;
  readonly h: number;
  /** Seed for the block/stain hashes — pass something stable per placement. */
  readonly seed: number;
  /** Plan taper over the full height, as a fraction of the half-extent. */
  readonly batter?: number;
  /** Cornice profile on top (default true). Its projection is included in `w`. */
  readonly cornice?: boolean;
  /** Override the bed-course height (small parapets want a coarser course). */
  readonly courseH?: number;
}): THREE.Group {
  const { w, d, h, seed } = opts;
  const batter = opts.batter ?? 0;
  const wantCornice = opts.cornice ?? true;
  const sink: Sink = new Map();

  // The cornice eats the top of the mass and projects back out to the nominal
  // width, so `w`/`d` stay the OUTERMOST dimensions whether or not there is one
  // — a caller sizing a block to a gap never has to know. Its projection is
  // capped as a share of the SMALL plan dimension: a parapet coping 0.42u proud
  // of a 0.66u-thick wall is a mushroom, not a moulding.
  const corniceOut = wantCornice ? Math.min(0.42, Math.min(w, d) * 0.12) : 0;
  const shaftHx = Math.max(0.15, w / 2 - corniceOut);
  const shaftHz = Math.max(0.15, d / 2 - corniceOut);
  // Floored as well as capped. A cornice sized as a pure fraction of the mass
  // gave a 1.05u parapet a 0.17u profile, i.e. three rings of 0.03–0.09u — every
  // one of them thinner than a pixel at any range, which is a z-fighting
  // dashed line along the coping rather than a moulding.
  const corniceH = wantCornice ? Math.min(0.95, Math.max(0.3, h * 0.16)) : 0;
  const shaftH = Math.max(opts.courseH ?? WEATHER.courseH, h - corniceH);
  // Joint reveal and arris cut scale down with a small member for the same
  // reason: they are a fraction of a wall, not of a garden wall coping.
  const fine = Math.min(1, Math.min(shaftHx, shaftHz) / 0.8);
  const jointDepth = WEATHER.jointDepth * fine;
  const chamfer = WEATHER.chamfer * fine;

  const nominalCourse = opts.courseH ?? WEATHER.courseH;
  const courses = Math.max(2, Math.round(shaftH / nominalCourse));
  const jointH = Math.min(WEATHER.jointHeight, (shaftH / courses) * 0.22);
  // Coursing consumes the joints out of the shaft, so the block's TOTAL height
  // is exactly `h` however the division lands.
  const stoneH = (shaftH - jointH * (courses - 1)) / courses;

  const rings: Ring[] = [];
  for (let k = 0; k < courses; k++) {
    if (k > 0) rings.push({ outset: -jointDepth, h: jointH, kind: "joint" });
    rings.push({ outset: 0, h: stoneH, kind: "stone" });
  }
  if (wantCornice && corniceH >= 0.5) {
    // Fillet, corona, cap. The corona is the member that does the work: it
    // projects far enough to throw a shadow onto the shaft and to shed water
    // clear of it, and the cap above steps back so the profile reads as three
    // planes rather than as one lump.
    rings.push({ outset: corniceOut * 0.29, h: corniceH * 0.26, kind: "trim" });
    rings.push({ outset: corniceOut, h: corniceH * 0.46, kind: "trim" });
    rings.push({ outset: corniceOut * 0.55, h: corniceH * 0.28, kind: "trim" });
  } else if (wantCornice) {
    // Too little height for a profile: one coping stone. A garden wall has one
    // and a three-part moulding on a parapet would be a doll's-house cornice.
    rings.push({ outset: corniceOut, h: corniceH, kind: "trim" });
  }

  // Outline of the shaft at height y, before a ring's own outset.
  const plan = chamferedPlan(shaftHx, shaftHz, chamfer);
  const outlineAt = (y: number, outset: number): [number, number][] => {
    const t = shaftH > 0 ? Math.min(1, Math.max(0, y / shaftH)) : 0;
    const sx = Math.max(0.15, shaftHx * (1 - batter * t));
    const sz = Math.max(0.15, shaftHz * (1 - batter * t));
    // Per-axis, so `outset` is a true perpendicular offset on the broad faces
    // (the chamfers take the average, which is what a mitre does anyway).
    const kx = (sx + outset) / shaftHx;
    const kz = (sz + outset) / shaftHz;
    return plan.map(([px, pz]) => [px * kx, pz * kz]);
  };

  /** Tone of stone `si` in course `k`, before the weathering overrides. */
  const stoneTone = (k: number, faceIdx: number, si: number, yMid: number): MasonryTone => {
    // Drip staining, strongest directly under the overhang and gone a few
    // metres down — the same exponential the concrete shader runs.
    const fromTop = shaftH - yMid;
    const stainP = WEATHER.stainShare * Math.exp(-fromTop / WEATHER.dripRun);
    if (hash(seed + faceIdx * 7.7 + si * 3.3, k * 1.9 + 41.3) < stainP) return "stain";
    // Damp at the foot: rising ground water, and the only reason the bottom of
    // an old abutment is never the colour of its top.
    if (hash(seed + faceIdx + si * 5.1, k + 91.7) < 0.55 * Math.exp(-yMid / WEATHER.dampRise)) {
      return "dark";
    }
    const pick = hash(seed + faceIdx * 2.3 + si * 11.7, k * 5.3);
    return pick < 0.3 ? "light" : pick < 0.62 ? "face" : "dark";
  };

  let y = 0;
  let prevTop: [number, number][] | null = null;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (!ring) continue;
    const lo = outlineAt(y, ring.outset);
    const hi = outlineAt(y + ring.h, ring.outset);
    const n = lo.length;

    // The horizontal return between the ring below and this one. Growing
    // outward means we are standing under an overhang (a cornice soffit, seen
    // from below); shrinking means we are looking down at a ledge the weather
    // washes. The two want opposite windings as well as opposite tones.
    if (prevTop) {
      const rBelow = Math.hypot(prevTop[0]?.[0] ?? 0, prevTop[0]?.[1] ?? 0);
      const rHere = Math.hypot(lo[0]?.[0] ?? 0, lo[0]?.[1] ?? 0);
      const grew = rHere > rBelow;
      // Only a REAL ledge is washed. The 0.075u return at the top of a bed
      // joint is a reveal inside a shadow, and painting it `wash` drew a bright
      // line at every single course — a stack of pancakes rather than a wall.
      const tone: MasonryTone = !grew && rBelow - rHere > 0.2 ? "wash" : "shade";
      for (let i = 0; i < n; i++) {
        const a = prevTop[i];
        const b = prevTop[(i + 1) % n];
        const c = lo[(i + 1) % n];
        const e = lo[i];
        if (!a || !b || !c || !e) continue;
        if (grew) {
          quad(sink, tone, [a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], [e[0], y, e[1]]);
        } else {
          quad(sink, tone, [a[0], y, a[1]], [e[0], y, e[1]], [c[0], y, c[1]], [b[0], y, b[1]]);
        }
      }
    }

    const courseIdx = Math.floor(r / 2);
    for (let i = 0; i < n; i++) {
      const a0 = lo[i];
      const b0 = lo[(i + 1) % n];
      const a1 = hi[i];
      const b1 = hi[(i + 1) % n];
      if (!a0 || !b0 || !a1 || !b1) continue;
      const len = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]);
      if (ring.kind !== "stone") {
        quad(
          sink,
          ring.kind === "joint" ? "shade" : "face",
          [a0[0], y, a0[1]],
          [a1[0], y + ring.h, a1[1]],
          [b1[0], y + ring.h, b1[1]],
          [b0[0], y, b0[1]],
        );
        continue;
      }
      // Running bond: every other course starts its perpends half a stone
      // along, so the vertical joints never stack into a column of weakness.
      const stones = Math.max(1, Math.round(len / WEATHER.stoneLen));
      const phase = courseIdx % 2 === 0 ? 0 : 0.5 / stones;
      const cuts: number[] = [0];
      for (let s = 1; s < stones; s++) cuts.push(Math.min(1, s / stones + phase));
      cuts.push(1);
      for (let s = 0; s + 1 < cuts.length; s++) {
        const t0 = cuts[s] ?? 0;
        const t1 = cuts[s + 1] ?? 1;
        if (t1 - t0 < 1e-4) continue;
        const at = (row: [number, number][], t: number, yy: number): [number, number, number] => {
          const a = row[i];
          const b = row[(i + 1) % n];
          if (!a || !b) return [0, yy, 0];
          return [a[0] + (b[0] - a[0]) * t, yy, a[1] + (b[1] - a[1]) * t];
        };
        quad(
          sink,
          stoneTone(courseIdx, i, s, y + ring.h / 2),
          at(lo, t0, y),
          at(hi, t0, y + ring.h),
          at(hi, t1, y + ring.h),
          at(lo, t1, y),
        );
      }
    }
    prevTop = hi;
    y += ring.h;
  }

  // Caps. The top is the only one anyone sees from a hill; the bottom exists so
  // the mass is closed however far a caller sinks it into the ground. The plan
  // winding puts the interior on the left of each edge, which fans DOWN — so
  // the top fan runs the other way round.
  const top = prevTop;
  if (top) {
    for (let i = 1; i + 1 < top.length; i++) {
      const a = top[0];
      const b = top[i];
      const c = top[i + 1];
      if (!a || !b || !c) continue;
      // `light`, not `wash`. From a car the top of a coping is edge-on, so it
      // is a one-pixel rim and the palest tone in the set has no room to read
      // as anything but a bright line. `wash` is for a ledge wide enough to
      // look DOWN at, which is what the cornice returns are.
      tri(sink, "light", [a[0], y, a[1]], [c[0], y, c[1]], [b[0], y, b[1]]);
    }
  }
  const base = outlineAt(0, 0);
  for (let i = 1; i + 1 < base.length; i++) {
    const a = base[0];
    const b = base[i];
    const c = base[i + 1];
    if (!a || !b || !c) continue;
    tri(sink, "shade", [a[0], 0, a[1]], [b[0], 0, b[1]], [c[0], 0, c[1]]);
  }

  const group = new THREE.Group();
  for (const [tone, buf] of sink) {
    if (buf.pos.length === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buf.pos), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(buf.nor), 3));
    const mesh = new THREE.Mesh(geo, MASONRY[tone]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/**
 * `masonryBlock`, seated and yawed in one call — the shape every caller in
 * this world actually wants. `y` is the FOOT of the mass, matching how
 * `ground.ts makeStandingSurface` hands out a seating height.
 */
export function seatMasonry(opts: {
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly seed: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw?: number;
  readonly batter?: number;
  readonly cornice?: boolean;
  readonly courseH?: number;
}): THREE.Group {
  const g = masonryBlock(opts);
  g.position.set(opts.x, opts.y, opts.z);
  g.rotation.y = opts.yaw ?? 0;
  g.updateMatrixWorld(true);
  return g;
}

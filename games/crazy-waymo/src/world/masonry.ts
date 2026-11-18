import * as THREE from "three";

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
  /** ...and a darker one. */
  dark: new THREE.MeshStandardMaterial({ color: 0x8e_96_9b, roughness: 1 }),
  /** The reference ashlar face. */
  face: new THREE.MeshStandardMaterial({ color: 0x9b_a3_a7, roughness: 1 }),
  /** A block from a paler bed of the same quarry. */
  light: new THREE.MeshStandardMaterial({ color: 0xa5_ad_b0, roughness: 1 }),
  /** Recessed bed joints and every down-facing return. Carries the ambient
   *  occlusion the flat lighting will not give a 0.07u reveal on its own. */
  shade: new THREE.MeshStandardMaterial({ color: 0x76_7e_83, roughness: 1 }),
  /** Drip staining under a cornice, and the damp at the foot of a wall. */
  stain: new THREE.MeshStandardMaterial({ color: 0x84_87_80, roughness: 1 }),
  /** Up-facing ledges: sun-bleached, and the only surface rain actually
   *  washes clean. */
  wash: new THREE.MeshStandardMaterial({ color: 0xaf_b5_b6, roughness: 1 }),
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
  /** Chamfer cut off every vertical arris. A stone block with a mathematically
   *  sharp corner is the single loudest "this is a primitive" tell; the real
   *  ones are always arris-cut, and the cut catches its own highlight. */
  chamfer: 0.16,
  /** Nominal bed-course height. The concrete shader's form-board seams run at
   *  0.62u; masonry courses are the coarser rhythm of the same idea. */
  courseH: 0.78,
  /** How far the damp climbs from the foot of a wall. */
  dampRise: 1.6,
  /** How far a drip stain runs down from under a cornice, in world units. The
   *  concrete shader's exponential streak decays over 3.2u; same number. */
  dripRun: 3.2,
  /** Peak darkening of a drip streak directly under the edge that sheds it. */
  dripValue: 0.24,
  /** Peak-to-peak aggregate speckle. Felt, never read. */
  grainValue: 0.05,
  /** Depth of a recessed bed joint, and the height of its reveal. */
  jointDepth: 0.075,
  jointHeight: 0.11,
  /** Darkening of a joint / seam line against the face it cuts. */
  jointValue: 0.18,
  /** Peak share of stones that take the stain tone directly under a drip line. */
  stainShare: 0.5,
  /** Nominal stone length along a face (perpend pitch). */
  stoneLen: 1.7,
} as const;

const hash = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43_758.5453;

  return s - Math.floor(s);
};

type Outline = readonly (readonly [number, number])[];

const chamferedPlan: (hx: number, hz: number, c: number) => Outline = (hx, hz, c) => {
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
};

interface Ring {
  readonly outset: number;
  readonly h: number;
  readonly kind: "stone" | "joint" | "trim";
}

type Sink = Map<MasonryTone, { pos: number[]; nor: number[] }>;

const sinkFor = (sink: Sink, tone: MasonryTone) => {
  let s = sink.get(tone);

  if (!s) {
    sink.set(tone, (s = { nor: [], pos: [] }));
  }

  return s;
};

type P3 = readonly [number, number, number];

const tri = (sink: Sink, tone: MasonryTone, a: P3, b: P3, c: P3) => {
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

  if (nl < 1e-9) {
    return;
  }

  nx /= nl;
  ny /= nl;
  nz /= nl;
  const s = sinkFor(sink, tone);

  for (const p of [a, b, c]) {
    s.pos.push(p[0], p[1], p[2]);
    s.nor.push(nx, ny, nz);
  }
};

const quad = (sink: Sink, tone: MasonryTone, a: P3, b: P3, c: P3, d: P3) => {
  tri(sink, tone, a, b, c);
  tri(sink, tone, a, c, d);
};

interface RingSpec {
  readonly courses: number;
  readonly stoneH: number;
  readonly jointH: number;
  readonly jointDepth: number;
  readonly wantCornice: boolean;
  readonly corniceH: number;
  readonly corniceOut: number;
}

const masonryRings = (spec: RingSpec) => {
  const rings: Ring[] = [];

  for (let k = 0; k < spec.courses; k += 1) {
    if (k > 0) {
      rings.push({ h: spec.jointH, kind: "joint", outset: -spec.jointDepth });
    }

    rings.push({ h: spec.stoneH, kind: "stone", outset: 0 });
  }

  if (spec.wantCornice && spec.corniceH >= 0.5) {
    rings.push(
      { h: spec.corniceH * 0.26, kind: "trim", outset: spec.corniceOut * 0.29 },
      { h: spec.corniceH * 0.46, kind: "trim", outset: spec.corniceOut },
      { h: spec.corniceH * 0.28, kind: "trim", outset: spec.corniceOut * 0.55 },
    );
  } else if (spec.wantCornice) {
    rings.push({ h: spec.corniceH, kind: "trim", outset: spec.corniceOut });
  }

  return rings;
};

type Row = readonly (readonly [number, number])[];

const ringReturn = (sink: Sink, prevTop: Row, lo: Row, y: number) => {
  const n = lo.length;
  const rBelow = Math.hypot(prevTop[0]?.[0] ?? 0, prevTop[0]?.[1] ?? 0);
  const rHere = Math.hypot(lo[0]?.[0] ?? 0, lo[0]?.[1] ?? 0);
  const grew = rHere > rBelow;
  const tone: MasonryTone = !grew && rBelow - rHere > 0.2 ? "wash" : "shade";

  for (let i = 0; i < n; i += 1) {
    const a = prevTop[i];
    const b = prevTop[(i + 1) % n];
    const c = lo[(i + 1) % n];
    const e = lo[i];

    if (!a || !b || !c || !e) {
      continue;
    }

    if (grew) {
      quad(sink, tone, [a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], [e[0], y, e[1]]);
    } else {
      quad(sink, tone, [a[0], y, a[1]], [e[0], y, e[1]], [c[0], y, c[1]], [b[0], y, b[1]]);
    }
  }
};

interface RingBand {
  readonly ring: Ring;
  readonly lo: Row;
  readonly hi: Row;
  readonly y: number;
}

type StoneTone = (k: number, faceIdx: number, si: number, yMid: number) => MasonryTone;

const ringFaces = (sink: Sink, band: RingBand, courseIdx: number, stoneTone: StoneTone) => {
  const { ring, lo, hi, y } = band;
  const n = lo.length;

  for (let i = 0; i < n; i += 1) {
    const a0 = lo[i];
    const b0 = lo[(i + 1) % n];
    const a1 = hi[i];
    const b1 = hi[(i + 1) % n];

    if (!a0 || !b0 || !a1 || !b1) {
      continue;
    }

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

    const stones = Math.max(1, Math.round(len / WEATHER.stoneLen));
    const phase = courseIdx % 2 === 0 ? 0 : 0.5 / stones;
    const cuts: number[] = [0];

    for (let s = 1; s < stones; s += 1) {
      cuts.push(Math.min(1, s / stones + phase));
    }

    cuts.push(1);

    const at: (row: Row, t: number, yy: number) => P3 = (row, t, yy) => {
      const a = row[i];
      const b = row[(i + 1) % n];

      if (!a || !b) {
        return [0, yy, 0];
      }

      return [a[0] + (b[0] - a[0]) * t, yy, a[1] + (b[1] - a[1]) * t];
    };

    for (let s = 0; s + 1 < cuts.length; s += 1) {
      const t0 = cuts[s] ?? 0;
      const t1 = cuts[s + 1] ?? 1;

      if (t1 - t0 < 1e-4) {
        continue;
      }

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
};

const masonryCaps = (sink: Sink, top: Row | null, y: number, base: Row) => {
  if (top) {
    const [a] = top;

    for (let i = 1; i + 1 < top.length; i += 1) {
      const b = top[i];
      const c = top[i + 1];

      if (!a || !b || !c) {
        continue;
      }

      tri(sink, "light", [a[0], y, a[1]], [c[0], y, c[1]], [b[0], y, b[1]]);
    }
  }

  const [a] = base;

  for (let i = 1; i + 1 < base.length; i += 1) {
    const b = base[i];
    const c = base[i + 1];

    if (!a || !b || !c) {
      continue;
    }

    tri(sink, "shade", [a[0], 0, a[1]], [b[0], 0, b[1]], [c[0], 0, c[1]]);
  }
};

const sinkGroup = (sink: Sink) => {
  const group = new THREE.Group();

  for (const [tone, buf] of sink) {
    if (buf.pos.length === 0) {
      continue;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buf.pos), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(buf.nor), 3));
    const mesh = new THREE.Mesh(geo, MASONRY[tone]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
};

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
export const masonryBlock = (opts: {
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
}) => {
  const { w, d, h, seed } = opts;
  const batter = opts.batter ?? 0;
  const wantCornice = opts.cornice ?? true;
  const sink: Sink = new Map();

  const corniceOut = wantCornice ? Math.min(0.42, Math.min(w, d) * 0.12) : 0;
  const shaftHx = Math.max(0.15, w / 2 - corniceOut);
  const shaftHz = Math.max(0.15, d / 2 - corniceOut);
  const corniceH = wantCornice ? Math.min(0.95, Math.max(0.3, h * 0.16)) : 0;
  const shaftH = Math.max(opts.courseH ?? WEATHER.courseH, h - corniceH);
  const fine = Math.min(1, Math.min(shaftHx, shaftHz) / 0.8);
  const jointDepth = WEATHER.jointDepth * fine;
  const chamfer = WEATHER.chamfer * fine;

  const nominalCourse = opts.courseH ?? WEATHER.courseH;
  const courses = Math.max(2, Math.round(shaftH / nominalCourse));
  const jointH = Math.min(WEATHER.jointHeight, (shaftH / courses) * 0.22);
  const stoneH = (shaftH - jointH * (courses - 1)) / courses;

  const rings = masonryRings({
    corniceH,
    corniceOut,
    courses,
    jointDepth,
    jointH,
    stoneH,
    wantCornice,
  });

  const plan = chamferedPlan(shaftHx, shaftHz, chamfer);

  const outlineAt: (y: number, outset: number) => [number, number][] = (y, outset) => {
    const t = shaftH > 0 ? Math.min(1, Math.max(0, y / shaftH)) : 0;
    const sx = Math.max(0.15, shaftHx * (1 - batter * t));
    const sz = Math.max(0.15, shaftHz * (1 - batter * t));
    const kx = (sx + outset) / shaftHx;
    const kz = (sz + outset) / shaftHz;

    return plan.map(([px, pz]) => [px * kx, pz * kz]);
  };

  const stoneTone: (k: number, faceIdx: number, si: number, yMid: number) => MasonryTone = (
    k,
    faceIdx,
    si,
    yMid,
  ) => {
    const fromTop = shaftH - yMid;
    const stainP = WEATHER.stainShare * Math.exp(-fromTop / WEATHER.dripRun);

    if (hash(seed + faceIdx * 7.7 + si * 3.3, k * 1.9 + 41.3) < stainP) {
      return "stain";
    }

    if (hash(seed + faceIdx + si * 5.1, k + 91.7) < 0.55 * Math.exp(-yMid / WEATHER.dampRise)) {
      return "dark";
    }

    const pick = hash(seed + faceIdx * 2.3 + si * 11.7, k * 5.3);

    if (pick < 0.3) {
      return "light";
    }

    return pick < 0.62 ? "face" : "dark";
  };

  let y = 0;
  let prevTop: [number, number][] | null = null;

  for (const [r, ring] of rings.entries()) {
    const lo = outlineAt(y, ring.outset);
    const hi = outlineAt(y + ring.h, ring.outset);

    if (prevTop) {
      ringReturn(sink, prevTop, lo, y);
    }

    ringFaces(sink, { hi, lo, ring, y }, Math.floor(r / 2), stoneTone);
    prevTop = hi;
    y += ring.h;
  }

  masonryCaps(sink, prevTop, y, outlineAt(0, 0));

  return sinkGroup(sink);
};

/**
 * `masonryBlock`, seated and yawed in one call — the shape every caller in
 * this world actually wants. `y` is the FOOT of the mass, matching how
 * `ground.ts makeStandingSurface` hands out a seating height.
 */
export const seatMasonry = (opts: {
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
}) => {
  const g = masonryBlock(opts);
  g.position.set(opts.x, opts.y, opts.z);
  g.rotation.y = opts.yaw ?? 0;
  g.updateMatrixWorld(true);

  return g;
};

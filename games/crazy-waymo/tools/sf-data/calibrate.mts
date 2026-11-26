import { at } from "./lib.mts";

const ANCHORS = [
  { lat: 37.7544, lon: -122.4477, name: "Twin Peaks", u: 0.42, v: 0.56 },
  // oxlint-disable-next-line oxc/approx-constant -- 0.693 is a map v coordinate, not ln 2
  { lat: 37.7383, lon: -122.4547, name: "Mount Davidson", u: 0.377, v: 0.693 },
  { lat: 37.7583, lon: -122.4575, name: "Mount Sutro", u: 0.359, v: 0.486 },
  { lat: 37.793, lon: -122.4161, name: "Nob Hill", u: 0.63, v: 0.172 },
  { lat: 37.8024, lon: -122.4058, name: "Telegraph Hill", u: 0.683, v: 0.082 },
  { lat: 37.801, lon: -122.418, name: "Russian Hill", u: 0.602, v: 0.091 },
  { lat: 37.744, lon: -122.416, name: "Bernal Heights", u: 0.621, v: 0.651 },
  { lat: 37.758, lon: -122.4, name: "Potrero Hill", u: 0.726, v: 0.509 },
  { lat: 37.788, lon: -122.39, name: "Rincon Hill", u: 0.778, v: 0.234 },
  { lat: 37.7925, lon: -122.4382, name: "Pacific Heights", u: 0.489, v: 0.182 },
  { lat: 37.769, lon: -122.442, name: "Buena Vista", u: 0.457, v: 0.404 },
  { lat: 37.7787, lon: -122.4527, name: "Lone Mountain", u: 0.396, v: 0.295 },
];

const fit = (xs: readonly number[], ys: readonly number[]) => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;

  for (let i = 0; i < n; i += 1) {
    sxy += (at(xs, i) - mx) * (at(ys, i) - my);
    sxx += (at(xs, i) - mx) * (at(xs, i) - mx);
  }

  const m = sxy / sxx;
  const b = my - m * mx;
  let ssRes = 0;
  let ssTot = 0;

  for (let i = 0; i < n; i += 1) {
    const pred = m * at(xs, i) + b;
    ssRes += (at(ys, i) - pred) ** 2;
    ssTot += (at(ys, i) - my) ** 2;
  }

  return { b, m, r2: 1 - ssRes / ssTot };
};

const uFit = fit(
  ANCHORS.map((a) => a.lon),
  ANCHORS.map((a) => a.u),
);

const vFit = fit(
  ANCHORS.map((a) => a.lat),
  ANCHORS.map((a) => a.v),
);

console.log("Projection fit (separable linear):");

console.log(`  u = ${uFit.m.toFixed(4)} * lon + ${uFit.b.toFixed(4)}   R^2=${uFit.r2.toFixed(5)}`);

console.log(`  v = ${vFit.m.toFixed(4)} * lat + ${vFit.b.toFixed(4)}   R^2=${vFit.r2.toFixed(5)}`);

let maxResU = 0;
let maxResV = 0;

for (const a of ANCHORS) {
  const pu = uFit.m * a.lon + uFit.b;
  const pv = vFit.m * a.lat + vFit.b;
  maxResU = Math.max(maxResU, Math.abs(pu - a.u));
  maxResV = Math.max(maxResV, Math.abs(pv - a.v));
}

console.log(
  `  max residual: u=${maxResU.toFixed(3)}  v=${maxResV.toFixed(3)} (fraction of map span)`,
);

const lonAtU0 = (0 - uFit.b) / uFit.m;
const lonAtU1 = (1 - uFit.b) / uFit.m;
const latAtV0 = (0 - vFit.b) / vFit.m;
const latAtV1 = (1 - vFit.b) / vFit.m;

console.log("\nGeographic box covered by u,v in [0,1]:");

console.log(`  u=0 lon ${lonAtU0.toFixed(4)} (W)  ->  u=1 lon ${lonAtU1.toFixed(4)} (E)`);

console.log(`  v=0 lat ${latAtV0.toFixed(4)} (N)  ->  v=1 lat ${latAtV1.toFixed(4)} (S)`);

const midLat = (latAtV0 + latAtV1) / 2;
const mPerDegLat = 111_132.9;
const mPerDegLon = 111_412.84 * Math.cos((midLat * Math.PI) / 180);
const widthM = Math.abs(lonAtU1 - lonAtU0) * mPerDegLon;
const heightM = Math.abs(latAtV1 - latAtV0) * mPerDegLat;

console.log("\nTrue metric size of the u,v box:");

console.log(`  width  (E-W) = ${(widthM / 1000).toFixed(2)} km`);

console.log(`  height (N-S) = ${(heightM / 1000).toFixed(2)} km`);

console.log(`  aspect ratio W:H = ${(widthM / heightM).toFixed(3)} : 1`);

export const PROJECTION = { heightM, uFit, vFit, widthM };

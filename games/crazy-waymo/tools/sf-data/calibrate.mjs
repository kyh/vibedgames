// Calibrate the lon/lat -> (u,v) projection used by sf-map.ts, by fitting a
// linear map against known SF hill summits whose (u,v) are already hand-placed
// in the game. This guarantees the real street network we rasterize lines up
// with the existing coastline, hills and neighborhoods.
//
// Also reports SF's true geographic aspect ratio so we can pick a map size that
// stops distorting the city into a square.

// Hill/landmark anchors: real (lat, lon) -> game (u, v) taken from sf-map.ts.
const ANCHORS = [
  { name: "Twin Peaks", lat: 37.7544, lon: -122.4477, u: 0.42, v: 0.56 },
  { name: "Mount Davidson", lat: 37.7383, lon: -122.4547, u: 0.377, v: 0.693 },
  { name: "Mount Sutro", lat: 37.7583, lon: -122.4575, u: 0.359, v: 0.486 },
  { name: "Nob Hill", lat: 37.793, lon: -122.4161, u: 0.63, v: 0.172 },
  { name: "Telegraph Hill", lat: 37.8024, lon: -122.4058, u: 0.683, v: 0.082 },
  { name: "Russian Hill", lat: 37.801, lon: -122.418, u: 0.602, v: 0.091 },
  { name: "Bernal Heights", lat: 37.744, lon: -122.416, u: 0.621, v: 0.651 },
  { name: "Potrero Hill", lat: 37.758, lon: -122.4, u: 0.726, v: 0.509 },
  { name: "Rincon Hill", lat: 37.788, lon: -122.39, u: 0.778, v: 0.234 },
  { name: "Pacific Heights", lat: 37.7925, lon: -122.4382, u: 0.489, v: 0.182 },
  { name: "Buena Vista", lat: 37.769, lon: -122.442, u: 0.457, v: 0.404 },
  { name: "Lone Mountain", lat: 37.7787, lon: -122.4527, u: 0.396, v: 0.295 },
];

// Ordinary least squares for y = m*x + b.
function fit(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  const m = sxy / sxx;
  const b = my - m * mx;
  // R^2
  let ssRes = 0,
    ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = m * xs[i] + b;
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  return { m, b, r2: 1 - ssRes / ssTot };
}

const uFit = fit(
  ANCHORS.map((a) => a.lon),
  ANCHORS.map((a) => a.u),
);
const vFit = fit(
  ANCHORS.map((a) => a.lat),
  ANCHORS.map((a) => a.v),
);

// u = uFit.m * lon + uFit.b ; v = vFit.m * lat + vFit.b
console.log("Projection fit (separable linear):");
console.log(`  u = ${uFit.m.toFixed(4)} * lon + ${uFit.b.toFixed(4)}   R^2=${uFit.r2.toFixed(5)}`);
console.log(`  v = ${vFit.m.toFixed(4)} * lat + ${vFit.b.toFixed(4)}   R^2=${vFit.r2.toFixed(5)}`);

// Residuals per anchor (in u/v units) to sanity-check.
let maxResU = 0,
  maxResV = 0;
for (const a of ANCHORS) {
  const pu = uFit.m * a.lon + uFit.b;
  const pv = vFit.m * a.lat + vFit.b;
  maxResU = Math.max(maxResU, Math.abs(pu - a.u));
  maxResV = Math.max(maxResV, Math.abs(pv - a.v));
}
console.log(
  `  max residual: u=${maxResU.toFixed(3)}  v=${maxResV.toFixed(3)} (fraction of map span)`,
);

// Invert to get the lon/lat that map to u,v in {0,1} — the geographic box the
// game's [0,1]x[0,1] normalized space covers.
const lonAtU0 = (0 - uFit.b) / uFit.m;
const lonAtU1 = (1 - uFit.b) / uFit.m;
const latAtV0 = (0 - vFit.b) / vFit.m;
const latAtV1 = (1 - vFit.b) / vFit.m;
console.log("\nGeographic box covered by u,v in [0,1]:");
console.log(`  u=0 lon ${lonAtU0.toFixed(4)} (W)  ->  u=1 lon ${lonAtU1.toFixed(4)} (E)`);
console.log(`  v=0 lat ${latAtV0.toFixed(4)} (N)  ->  v=1 lat ${latAtV1.toFixed(4)} (S)`);

// True metric size of that box (WGS84 approx at SF latitude).
const midLat = (latAtV0 + latAtV1) / 2;
const mPerDegLat = 111132.9;
const mPerDegLon = 111412.84 * Math.cos((midLat * Math.PI) / 180);
const widthM = Math.abs(lonAtU1 - lonAtU0) * mPerDegLon;
const heightM = Math.abs(latAtV1 - latAtV0) * mPerDegLat;
console.log("\nTrue metric size of the u,v box:");
console.log(`  width  (E-W) = ${(widthM / 1000).toFixed(2)} km`);
console.log(`  height (N-S) = ${(heightM / 1000).toFixed(2)} km`);
console.log(`  aspect ratio W:H = ${(widthM / heightM).toFixed(3)} : 1`);

export const PROJECTION = { uFit, vFit, widthM, heightM };

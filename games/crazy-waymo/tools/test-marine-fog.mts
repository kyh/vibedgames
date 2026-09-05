import { marineDensity, marineOpacity } from "../src/render/marine-profile";
import { MarineSky } from "../src/render/marine-sky";

type Check = (name: string, condition: boolean, detail?: string) => void;

export function checkMarineFog(check: Check): void {
  const sunset = { x: -1000, y: 8, z: 350 };
  const inland = { x: 400, y: 8, z: 350 };
  const sunsetBlock = marineOpacity(sunset, { ...sunset, z: sunset.z + 250 });
  const inlandBlock = marineOpacity(inland, { ...inland, z: inland.z + 250 });
  check(
    "coastal streets have a prominent marine bank while inland blocks remain clear",
    sunsetBlock > 0.4 && sunsetBlock < 0.75 && inlandBlock < 0.03,
    `Sunset ${sunsetBlock.toFixed(3)}, inland ${inlandBlock.toFixed(3)}`,
  );

  const bumper = marineOpacity(sunset, { ...sunset, z: sunset.z + 26 });
  const markings = marineOpacity(sunset, { ...sunset, z: sunset.z + 50 });
  check(
    "marine fog leaves the car untouched and the first road markings readable",
    bumper === 0 && markings < 0.04,
    `26u ${bumper}, 50u ${markings.toFixed(3)}`,
  );

  const clearTarget = { x: 600, y: 8, z: 350 };
  const through = marineOpacity(sunset, clearTarget);
  check(
    "a clear inland surface seen through coastal air retains intervening fog",
    marineDensity(clearTarget.x, clearTarget.y, clearTarget.z) === 0 && through > 0.2,
    through.toFixed(3),
  );

  // The bridge deck is 7u above water; the chase camera sits ~5u above it.
  const gate = { x: -730, y: 12, z: -1170 };
  const gateDeck = marineOpacity(gate, { ...gate, z: gate.z + 220 });
  check(
    "Golden Gate deck sees a soft bank without losing the next bridge section",
    gateDeck > 0.3 && gateDeck < 0.7,
    gateDeck.toFixed(3),
  );
  const gateView = { x: -793, y: 25.5, z: -988 };
  const tower = marineOpacity(gateView, { x: -730, y: 51, z: -1417 });
  const deck = marineOpacity(gateView, { x: -730, y: 7, z: -1417 });
  check(
    "Golden Gate tower tops emerge above a denser deck and water bank",
    tower < 0.3 && deck > 0.55 && deck > tower * 2,
    `tower ${tower.toFixed(3)}, deck ${deck.toFixed(3)}`,
  );

  const summit = { ...sunset, y: 110 };
  const above = marineOpacity(summit, { ...summit, z: summit.z + 1000 });
  const below = marineOpacity(summit, { ...sunset, z: sunset.z + 400 });
  check(
    "hilltops emerge above the bank while views down into it retain depth",
    above === 0 && below > 0.1,
    `above ${above}, below ${below.toFixed(3)}`,
  );

  const distances = [26, 50, 100, 200, 400, 800, 1600, 3600];
  const opacities = distances.map((distance) =>
    marineOpacity(sunset, { ...sunset, z: sunset.z + distance }),
  );
  check(
    "fog remains bounded and gathers smoothly along a uniform coastal street",
    opacities.every(
      (opacity, i) =>
        Number.isFinite(opacity) &&
        opacity >= 0 &&
        opacity <= 0.84 &&
        opacity >= (opacities[i - 1] ?? 0),
    ),
    opacities.map((opacity) => opacity.toFixed(3)).join(", "),
  );

  let maximumDelta = 0;
  let previous = 0;
  for (let y = 0; y <= 90; y += 0.1) {
    const opacity = marineOpacity({ ...sunset, y }, { ...sunset, y, z: sunset.z + 350 });
    if (y > 0) maximumDelta = Math.max(maximumDelta, Math.abs(opacity - previous));
    previous = opacity;
  }
  check("cresting the marine lid has no visibility discontinuity", maximumDelta < 0.01);

  const sky = new MarineSky();
  const indices = sky.mesh.geometry.index;
  check(
    "marine sky uses one bounded horizon mesh without depth writes or shadow work",
    sky.mesh.children.length === 0 &&
      indices !== null &&
      indices.count / 3 <= 5000 &&
      !sky.mesh.castShadow &&
      !Array.isArray(sky.mesh.material) &&
      !sky.mesh.material.depthWrite,
    `${indices?.count ?? 0} indices`,
  );
  sky.mesh.geometry.dispose();
  if (!Array.isArray(sky.mesh.material)) sky.mesh.material.dispose();
}

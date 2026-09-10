import type { RaycastVehicle, VehicleParams } from "./raycast-vehicle";

// Live vehicle tuning (?tune=1) — the reference repo's lil-gui panel, as a
// zero-dependency DOM strip. Numeric params get sliders, booleans checkboxes;
// wheel-level params re-apply to the controller on change.

type NumericVehicleParam = {
  [K in keyof VehicleParams]: VehicleParams[K] extends number ? K : never;
}[keyof VehicleParams];
type BooleanVehicleParam = {
  [K in keyof VehicleParams]: VehicleParams[K] extends boolean ? K : never;
}[keyof VehicleParams];

interface NumSpec {
  key: NumericVehicleParam;
  min: number;
  max: number;
  step: number;
}

const NUMS: NumSpec[] = [
  { key: "engineForce", max: 12_000, min: 1000, step: 100 },
  { key: "boostMultiplier", max: 3, min: 1, step: 0.05 },
  { key: "cruiseSpeed", max: 60, min: 10, step: 1 },
  { key: "maxSpeed", max: 80, min: 20, step: 1 },
  { key: "maxSteer", max: 1, min: 0.2, step: 0.01 },
  { key: "steerSpeed", max: 16, min: 1, step: 0.5 },
  { key: "highSpeedSteer", max: 1, min: 0.2, step: 0.05 },
  { key: "brakeDecel", max: 80, min: 5, step: 1 },
  { key: "brakeRamp", max: 1, min: 0.05, step: 0.05 },
  { key: "slideAngle", max: 0.9, min: 0.15, step: 0.01 },
  { key: "arcMin", max: 2.5, min: 0.3, step: 0.05 },
  { key: "arcMax", max: 4.5, min: 1, step: 0.05 },
  { key: "driftDecay", max: 10, min: 0, step: 0.5 },
  { key: "turbo1T", max: 2, min: 0.3, step: 0.05 },
  { key: "turbo2T", max: 3.5, min: 0.6, step: 0.05 },
  { key: "turbo1Boost", max: 24, min: 4, step: 1 },
  { key: "turbo2Boost", max: 36, min: 8, step: 1 },
  { key: "airborneGravityScale", max: 3, min: 1, step: 0.05 },
  { key: "suspensionStiffness", max: 160, min: 10, step: 1 },
  { key: "suspensionRestLength", max: 1, min: 0.2, step: 0.01 },
  { key: "maxSuspensionTravel", max: 1, min: 0.1, step: 0.01 },
  { key: "frictionSlip", max: 20, min: 1, step: 0.1 },
  { key: "dampingCompression", max: 10, min: 0.5, step: 0.1 },
  { key: "dampingRelaxation", max: 10, min: 0.5, step: 0.1 },
  { key: "tiltClampAirborne", max: 10, min: 0, step: 0.5 },
  { key: "cornerLiftDamping", max: 1, min: 0.2, step: 0.05 },
  { key: "gripLoadCap", max: 5, min: 1, step: 0.1 },
  { key: "landingGripTime", max: 1, min: 0, step: 0.05 },
  { key: "landingGripFactor", max: 1, min: 0, step: 0.05 },
];

const BOOLS: BooleanVehicleParam[] = ["antiWheelie", "uprightAssist"];

export const mountTunePanel = (vehicle: RaycastVehicle): void => {
  const wrap = document.createElement("div");
  wrap.id = "tune";
  wrap.style.cssText =
    "position:fixed;top:60px;right:10px;z-index:60;width:250px;max-height:80vh;overflow-y:auto;" +
    "background:rgba(8,10,18,.92);border:1px solid rgba(255,210,74,.4);border-radius:10px;" +
    "padding:10px;font:600 10px ui-monospace,monospace;color:#fff;pointer-events:auto";
  const title = document.createElement("div");
  title.textContent = "VEHICLE TUNING";
  title.style.cssText = "color:#ffd24a;font-size:12px;margin-bottom:8px";
  wrap.append(title);

  const reapply = (): void => {
    for (let i = 0; i < 4; i += 1) {
      vehicle.applyWheelParams(i);
    }
  };

  for (const spec of NUMS) {
    const row = document.createElement("label");
    row.style.cssText = "display:block;margin-bottom:6px";
    const name = document.createElement("div");
    const value = vehicle.params[spec.key];
    name.textContent = `${spec.key}: ${String(value)}`;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(value);
    input.style.width = "100%";
    input.addEventListener("input", () => {
      const v = Number(input.value);
      vehicle.params[spec.key] = v;
      name.textContent = `${spec.key}: ${v}`;
      reapply();
    });
    row.append(name, input);
    wrap.append(row);
  }
  for (const key of BOOLS) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:4px";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = vehicle.params[key] === true;
    input.addEventListener("change", () => {
      vehicle.params[key] = input.checked;
    });
    row.append(input, document.createTextNode(String(key)));
    wrap.append(row);
  }
  document.body.append(wrap);
};

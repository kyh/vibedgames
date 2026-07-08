import type { RaycastVehicle, VehicleParams } from "./raycast-vehicle";

// Live vehicle tuning (?tune=1) — the reference repo's lil-gui panel, as a
// zero-dependency DOM strip. Numeric params get sliders, booleans checkboxes;
// wheel-level params re-apply to the controller on change.

type NumSpec = { key: keyof VehicleParams; min: number; max: number; step: number };

const NUMS: NumSpec[] = [
  { key: "engineForce", min: 1000, max: 12000, step: 100 },
  { key: "boostMultiplier", min: 1, max: 3, step: 0.05 },
  { key: "cruiseSpeed", min: 10, max: 60, step: 1 },
  { key: "maxSpeed", min: 20, max: 80, step: 1 },
  { key: "maxSteer", min: 0.2, max: 1, step: 0.01 },
  { key: "steerSpeed", min: 1, max: 16, step: 0.5 },
  { key: "highSpeedSteer", min: 0.2, max: 1, step: 0.05 },
  { key: "brakeForce", min: 500, max: 8000, step: 100 },
  { key: "driftGrip", min: 0.05, max: 1, step: 0.05 },
  { key: "driftYawRate", min: 0.5, max: 6, step: 0.25 },
  { key: "driftAssist", min: 1, max: 16, step: 0.5 },
  { key: "driftMaxSlip", min: 0.2, max: 1.4, step: 0.05 },
  { key: "driftBrakeFade", min: 0, max: 1, step: 0.01 },
  { key: "brakeRamp", min: 0.05, max: 1, step: 0.05 },
  { key: "airborneGravityScale", min: 1, max: 3, step: 0.05 },
  { key: "suspensionStiffness", min: 10, max: 160, step: 1 },
  { key: "suspensionRestLength", min: 0.2, max: 1, step: 0.01 },
  { key: "maxSuspensionTravel", min: 0.1, max: 1, step: 0.01 },
  { key: "frictionSlip", min: 1, max: 20, step: 0.1 },
  { key: "dampingCompression", min: 0.5, max: 10, step: 0.1 },
  { key: "dampingRelaxation", min: 0.5, max: 10, step: 0.1 },
  { key: "tiltClampAirborne", min: 0, max: 10, step: 0.5 },
  { key: "cornerLiftDamping", min: 0.2, max: 1, step: 0.05 },
  { key: "gripLoadCap", min: 1, max: 5, step: 0.1 },
  { key: "landingGripTime", min: 0, max: 1, step: 0.05 },
  { key: "landingGripFactor", min: 0, max: 1, step: 0.05 },
];

const BOOLS: (keyof VehicleParams)[] = ["antiWheelie", "uprightAssist"];

export function mountTunePanel(vehicle: RaycastVehicle): void {
  const wrap = document.createElement("div");
  wrap.id = "tune";
  wrap.style.cssText =
    "position:fixed;top:60px;right:10px;z-index:60;width:250px;max-height:80vh;overflow-y:auto;" +
    "background:rgba(8,10,18,.92);border:1px solid rgba(255,210,74,.4);border-radius:10px;" +
    "padding:10px;font:600 10px ui-monospace,monospace;color:#fff;pointer-events:auto";
  const title = document.createElement("div");
  title.textContent = "VEHICLE TUNING";
  title.style.cssText = "color:#ffd24a;font-size:12px;margin-bottom:8px";
  wrap.appendChild(title);

  const reapply = (): void => {
    for (let i = 0; i < 4; i++) vehicle.applyWheelParams(i);
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
      (vehicle.params as Record<string, number | boolean>)[spec.key] = v;
      name.textContent = `${spec.key}: ${v}`;
      reapply();
    });
    row.append(name, input);
    wrap.appendChild(row);
  }
  for (const key of BOOLS) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:4px";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = vehicle.params[key] === true;
    input.addEventListener("change", () => {
      (vehicle.params as Record<string, number | boolean>)[key] = input.checked;
    });
    row.append(input, document.createTextNode(String(key)));
    wrap.appendChild(row);
  }
  document.body.appendChild(wrap);
}

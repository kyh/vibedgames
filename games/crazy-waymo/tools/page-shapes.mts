import { z } from "zod";

import type { JsonValue } from "../src/shared/json.ts";

const uv = z.object({ u: z.number(), v: z.number() });

/** What `window.__taxi.probe()` reports about the player's car. */
export const probeSchema = z.object({
  airborne: z.boolean(),
  boosting: z.boolean(),
  carrying: z.boolean(),
  drifting: z.boolean(),
  heading: z.number(),
  nearestTraffic: z.object({ dist: z.number(), wrecked: z.boolean(), y: z.number() }).nullable(),
  objective: uv.nullable(),
  speed: z.number(),
  wreckedCount: z.number(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

/** The probe expression every browser check reads the car through. */
export const PROBE = "window.__taxi.probe()";

/** Any JSON value, as a page answer kept whole for a report. */
export const jsonSchema: z.ZodType<JsonValue> = z.json();

/** One verdict a browser check records. */
export interface CheckEntry {
  readonly evidence: JsonValue;
  readonly name: string;
  readonly passed: boolean;
}

/** A pass/fail list that prints each check as it lands and keeps its evidence for the report. */
export const createChecks = () => {
  const checks: CheckEntry[] = [];

  const check = (name: string, passed: boolean, evidence: JsonValue) => {
    checks.push({ evidence, name, passed });
    console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(evidence)}`);
  };

  return { check, checks, failed: () => checks.some((entry) => !entry.passed) };
};

import { expect, test } from "@playwright/test";

// E2E census smoke: loads the real game and asserts the cross-representation
// invariants that unit tests can't reach (they need the fully built city +
// physics). Each check here is the automated form of a manual census that
// caught a shipped bug in 2026-07:
//   1. sightless solids — collision with no visual = "invisible walls"
//   2. props stranded on vector asphalt = "things on the floor"
//   3. drive probe — car accelerates and rides the drive surface (float bug)
// Run: pnpm test:e2e (starts its own dev server via playwright webServer).

// ONE test on one page: the SwiftShader city build is the dominant cost
// (60-120s), so the census and the drive probe share it.
test.setTimeout(420_000);

// Typed view of the dev hooks (installed by src/debug/dev-hooks.ts, DEV only).
type TaxiHooks = {
  game: {
    isReady: boolean;
    handleStartPress: () => void;
    city: unknown;
  };
  probe: () => { x: number; y: number; z: number; speed: number };
};

declare global {
  interface Window {
    __taxi?: TaxiHooks;
  }
}

async function loadGame(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => window.__taxi?.game.isReady === true, undefined, {
    timeout: 150_000,
    polling: 1_000,
  });
}

test("world census + drive probe", async ({ page }) => {
  await loadGame(page);
  const census = await page.evaluate(() => {
    type Item = { url: string | null; m: Float32Array };
    type SolidT = {
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
      noBody?: boolean;
      unseen?: string;
    };
    const game = window.__taxi;
    if (!game) throw new Error("no dev hooks");
    const city = game.game.city as {
      solids: SolidT[];
      restPayload: { batchItems: Item[]; rawGeos: unknown[] } | null;
      restCapture: { batchItems: Item[] } | null;
      network: {
        nearest: (
          x: number,
          z: number,
          d: number,
        ) => { dist: number; edge: { half: number } } | null;
      };
    };
    const items = city.restPayload?.batchItems ?? city.restCapture?.batchItems ?? [];

    // Spatial hash of everything visible (batch items = every merged visual).
    const CELL = 8;
    const seen = new Map<string, boolean>();
    const key = (x: number, z: number): string => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    for (const it of items) {
      const x = it.m[12];
      const z = it.m[14];
      if (x === undefined || z === undefined) continue;
      seen.set(key(x, z), true);
    }
    const hasVisualNear = (x: number, z: number): boolean => {
      const bx = Math.floor(x / CELL);
      const bz = Math.floor(z / CELL);
      for (let ix = bx - 2; ix <= bx + 2; ix++) {
        for (let iz = bz - 2; iz <= bz + 2; iz++) {
          if (seen.has(`${ix},${iz}`)) return true;
        }
      }
      return false;
    };

    let sightless = 0;
    const sightlessSamples: string[] = [];
    let onAsphalt = 0;
    for (const s of city.solids) {
      const cx = (s.minX + s.maxX) / 2;
      const cz = (s.minZ + s.maxZ) / 2;
      // 1. Sightless: a hittable solid with no visual within ~16u and no
      // unseen tag. (Merged-chunk geometry like the seawall lips and generated
      // plinths ARE batch items, so legit walls always have a nearby item.)
      // noBody solids are NOT exempt: the arcade car collision ignores noBody
      // (it only skips Rapier), so a stranded tree solid is still a wall.
      if (!s.unseen && !hasVisualNear(cx, cz)) {
        sightless++;
        if (sightlessSamples.length < 5) {
          sightlessSamples.push(`${cx.toFixed(0)},${cz.toFixed(0)}`);
        }
      }
      // 2. On-asphalt: solid centered inside a street's paved band. The only
      // intentional residents are construction chicanes + bridge deck rails.
      if (!s.noBody) {
        const hit = city.network.nearest(cx, cz, 12);
        if (hit && hit.dist < hit.edge.half - 0.8) onAsphalt++;
      }
    }
    return {
      solids: city.solids.length,
      items: items.length,
      sightless,
      sightlessSamples,
      onAsphalt,
    };
  });

  expect(census.items).toBeGreaterThan(10_000); // the city actually built
  expect(
    census.sightless,
    `sightless solids at: ${census.sightlessSamples.join(" | ")} — a solid the player can hit must have a visual (or an unseen tag)`,
  ).toBe(0);
  // Chicanes (~31) + bridge rails (~5) + a handful of avenue-building OBB
  // overhangs. Alert on GROWTH, not the known baseline.
  expect(census.onAsphalt, "solids centered on street asphalt").toBeLessThan(60);
  // --- Drive probe (same page/city) ---
  // State-driven, not wall-clock-driven: under headless SwiftShader the game
  // clock runs slower than wall time (clamped dt), so fixed sleeps land mid-
  // countdown and read speed 0.
  await page.evaluate(() => {
    const game = window.__taxi?.game as { handleStartPress: () => void; mode: { kind: string } };
    game.handleStartPress(); // -> countdown (start() has reset the run)
    // Skip the 4.3s camera-swoop cinematic: it advances on GAME time, which
    // under SwiftShader crawls at a fraction of wall time.
    game.mode = { kind: "playing" };
  });
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", bubbles: true })),
  );
  await page.waitForFunction(() => (window.__taxi?.probe().speed ?? 0) > 12, undefined, {
    timeout: 120_000,
    polling: 500,
  });
  const result = await page.evaluate(() => {
    const taxi = window.__taxi;
    if (!taxi) throw new Error("no dev hooks");
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "w", code: "KeyW", bubbles: true }));
    const p = taxi.probe();
    const city = taxi.game.city as { heightAt: (x: number, z: number) => number };
    return { speed: p.speed, gap: p.y - city.heightAt(p.x, p.z) };
  });
  expect(result.speed, "car should reach cruise from a standing start").toBeGreaterThan(12);
  // Visual origin sits at the wheel bottoms; > 0.6 above the surface = the
  // float bug, < -0.3 = sunk through it.
  expect(result.gap).toBeGreaterThan(-0.3);
  expect(result.gap).toBeLessThan(0.6);
  // --- Physics residency (same page) ---
  // Static solids STREAM around the taxi (physics-world.ts): Rapier charges a
  // ~linear per-resident-collider cost every step even at rest, and making all
  // ~32k solids resident once cost the entire mobile frame budget (66ms/frame
  // at quality floor). Lock the architecture: near-spawn solids present, total
  // residents far below the full solid count.
  const colliders = await page.evaluate(() => {
    const game = window.__taxi?.game as unknown as {
      physics: { raw: () => { colliders: { forEach: (cb: () => void) => void } } };
    };
    let n = 0;
    game.physics.raw().colliders.forEach(() => n++);
    return n;
  });
  expect(colliders, "spawn-area solids must be resident").toBeGreaterThan(50);
  expect(colliders, "static solids must stream, never all be resident").toBeLessThan(8000);
});

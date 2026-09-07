/** Optional loop. Coordinates are existing pearls in the original maze. */
export const CIRCUIT_NAME = "Pearl circuit";
export const CIRCUIT_BEST_KEY = "pacman:pearl-circuit:v2:best";

export type CircuitCell = { readonly col: number; readonly row: number };

/** The original walkable loop, entered straight ahead from spawn at (9, 1). */
export const CIRCUIT_PATH: readonly CircuitCell[] = [
  { col: 9, row: 1 },
  { col: 10, row: 1 },
  { col: 11, row: 1 },
  { col: 11, row: 2 },
  { col: 11, row: 3 },
  { col: 12, row: 3 },
  { col: 13, row: 3 },
  { col: 13, row: 2 },
  { col: 13, row: 1 },
  { col: 14, row: 1 },
  { col: 15, row: 1 },
  { col: 15, row: 2 },
  { col: 15, row: 3 },
  { col: 15, row: 4 },
  { col: 15, row: 5 },
  { col: 14, row: 5 },
  { col: 13, row: 5 },
  { col: 13, row: 6 },
  { col: 13, row: 7 },
  { col: 14, row: 7 },
  { col: 15, row: 7 },
  { col: 15, row: 8 },
  { col: 15, row: 9 },
  { col: 14, row: 9 },
  { col: 13, row: 9 },
  { col: 12, row: 9 },
  { col: 11, row: 9 },
  { col: 11, row: 10 },
  { col: 11, row: 11 },
  { col: 10, row: 11 },
  { col: 9, row: 11 },
  { col: 9, row: 10 },
  { col: 9, row: 9 },
  { col: 9, row: 8 },
  { col: 9, row: 7 },
  { col: 10, row: 7 },
  { col: 11, row: 7 },
  { col: 11, row: 6 },
  { col: 11, row: 5 },
  { col: 10, row: 5 },
  { col: 9, row: 5 },
  { col: 9, row: 4 },
  { col: 9, row: 3 },
  { col: 9, row: 2 },
];

/** Existing pearls marked along the loop; the 28-bit mask stays positive. */
export const CIRCUIT_CELLS: readonly CircuitCell[] = [
  { col: 9, row: 1 },
  { col: 10, row: 1 },
  { col: 11, row: 1 },
  { col: 11, row: 2 },
  { col: 11, row: 3 },
  { col: 12, row: 3 },
  { col: 13, row: 3 },
  { col: 13, row: 2 },
  { col: 13, row: 1 },
  { col: 14, row: 1 },
  { col: 15, row: 1 },
  { col: 15, row: 2 },
  { col: 15, row: 3 },
  { col: 15, row: 4 },
  { col: 15, row: 5 },
  { col: 13, row: 5 },
  { col: 13, row: 7 },
  { col: 15, row: 7 },
  { col: 14, row: 9 },
  { col: 11, row: 9 },
  { col: 11, row: 11 },
  { col: 9, row: 11 },
  { col: 9, row: 9 },
  { col: 9, row: 7 },
  { col: 11, row: 7 },
  { col: 11, row: 5 },
  { col: 9, row: 5 },
  { col: 9, row: 2 },
];
export const CIRCUIT_GOAL = CIRCUIT_CELLS.length;
const ALL_PEARLS = (1 << CIRCUIT_GOAL) - 1;

export type CircuitReceipt = { readonly elapsedMs: number; readonly catches: number };

export type CircuitRun =
  | {
      readonly kind: "running";
      readonly remainingMask: number;
      readonly elapsedMs: number;
      readonly catches: number;
    }
  | { readonly kind: "complete"; readonly receipt: CircuitReceipt };

export function startCircuit(): CircuitRun {
  return { kind: "running", remainingMask: ALL_PEARLS, elapsedMs: 0, catches: 0 };
}

/** Call only for actual PLAYING time; READY, pause and results do not accrue time. */
export function tickCircuit(run: CircuitRun, dtSeconds: number): CircuitRun {
  if (run.kind === "complete" || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return run;
  const elapsedMs = run.elapsedMs + dtSeconds * 1000;
  if (elapsedMs > Number.MAX_SAFE_INTEGER) return run;
  return { ...run, elapsedMs };
}

/** Call only after the local pearl field accepted the pickup, never on a wire removal. */
export function collectCircuitPearl(run: CircuitRun, col: number, row: number): CircuitRun {
  if (run.kind === "complete") return run;
  const index = CIRCUIT_CELLS.findIndex((cell) => cell.col === col && cell.row === row);
  if (index < 0 || !circuitPearlRemaining(run, index)) return run;
  const remainingMask = run.remainingMask & ~(1 << index);
  if (remainingMask > 0) return { ...run, remainingMask };
  return {
    kind: "complete",
    receipt: { elapsedMs: Math.round(run.elapsedMs), catches: run.catches },
  };
}

/** A capture is recorded once by the existing caught edge, without changing lives. */
export function catchCircuit(run: CircuitRun): CircuitRun {
  if (run.kind === "complete") return run;
  return { ...run, catches: run.catches + 1 };
}

export function circuitPearlRemaining(run: CircuitRun, index: number): boolean {
  return (
    run.kind === "running" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < CIRCUIT_GOAL &&
    (run.remainingMask & (1 << index)) !== 0
  );
}

export function circuitCollected(run: CircuitRun): number {
  if (run.kind === "complete") return CIRCUIT_GOAL;
  let remaining = 0;
  for (let index = 0; index < CIRCUIT_GOAL; index++) {
    if (circuitPearlRemaining(run, index)) remaining++;
  }
  return CIRCUIT_GOAL - remaining;
}

/** Parse only completed receipts; the versioned key never shares normal score storage. */
export function parseCircuitBest(raw: string | null): CircuitReceipt | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    // JSON.parse creates local-realm objects; no cross-frame object enters here.
    if (!(value instanceof Object)) return null;
    if (!("elapsedMs" in value) || !("catches" in value)) return null;
    const elapsedMs = Number(value.elapsedMs);
    const catches = Number(value.catches);
    if (
      elapsedMs !== value.elapsedMs ||
      !Number.isSafeInteger(elapsedMs) ||
      elapsedMs < 0 ||
      catches !== value.catches ||
      !Number.isSafeInteger(catches) ||
      catches < 0
    )
      return null;
    return { elapsedMs, catches };
  } catch {
    return null;
  }
}

/** Fastest completed circuit wins; equal times favor fewer catches. */
export function improveCircuitBest(
  best: CircuitReceipt | null,
  receipt: CircuitReceipt,
): CircuitReceipt {
  if (
    best === null ||
    receipt.elapsedMs < best.elapsedMs ||
    (receipt.elapsedMs === best.elapsedMs && receipt.catches < best.catches)
  )
    return receipt;
  return best;
}

export function formatCircuitTime(elapsedMs: number): string {
  const tenths = Math.max(0, Math.floor(elapsedMs / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

/**
 * Client-side money formatting for the credit system. Amounts are integer
 * micro-USD (1_000_000 = $1.00) end to end; only display code divides.
 */
export const MICRO_PER_USD = 1_000_000;

/** 2 decimals normally; 4 when sub-cent so tiny charges don't show as $0.00. */
export const formatUsd = (micro: number): string => {
  const abs = Math.abs(micro);
  const decimals = abs > 0 && abs < MICRO_PER_USD / 100 ? 4 : 2;
  return `${micro < 0 ? "-" : ""}$${(abs / MICRO_PER_USD).toFixed(decimals)}`;
};

export const kindLabel = (kind: string, deltaMicro: number): string => {
  if (kind === "admin_grant") return deltaMicro < 0 ? "Adjustment" : "Credit grant";
  const labels: Record<string, string> = {
    signup_grant: "Welcome credits",
    generation_hold: "Generation",
    generation_settle: "Usage adjustment",
    generation_release: "Refund — failed generation",
  };
  return labels[kind] ?? kind;
};

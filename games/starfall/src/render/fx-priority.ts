export type FxImportance = "common" | "important";

/** Keep a quarter of the stroke pool free for major beats. Traffic may replace
 * an older common effect, but never a shield, progression or boss response. */
export function admitFx<T extends { importance: FxImportance }>(
  entries: T[],
  capacity: number,
  importance: FxImportance,
): boolean {
  const limit = importance === "important" ? capacity : capacity - Math.ceil(capacity / 4);
  if (entries.length < limit) return true;
  const expendable = entries.findIndex((entry) => entry.importance === "common");
  if (expendable < 0) return false;
  entries.splice(expendable, 1);
  return true;
}

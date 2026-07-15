import { readFileSync } from "node:fs";

/**
 * One item of the director's typed backlog. The file is written by subagents,
 * so every field is re-validated here — never trust its shape.
 */
export type BacklogItem = {
  id: string;
  title: string;
  role: string;
  type: string;
  priority: number;
  done: boolean;
};

const asString = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";

/**
 * Read + defensively parse `.vgfactory/backlog.json`. Open items first (by
 * priority), done items last — the order the dashboard displays. Returns []
 * when the file is missing, unreadable, or not an array.
 */
export function readBacklog(path: string): BacklogItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items: BacklogItem[] = [];
  for (const [i, raw] of parsed.entries()) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const title = asString(record.title) || asString(record.detail);
    if (!title) continue;
    const priority = typeof record.priority === "number" ? record.priority : 99;
    items.push({
      id: asString(record.id) || String(i + 1),
      title,
      role: asString(record.role),
      type: asString(record.type),
      priority,
      done: asString(record.status).toLowerCase() === "done",
    });
  }
  items.sort((a, b) => (a.done === b.done ? a.priority - b.priority : a.done ? 1 : -1));
  return items;
}

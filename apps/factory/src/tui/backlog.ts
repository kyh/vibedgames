import { readFileSync } from "node:fs";

import { asJsonObject, asNumber, isJsonNumber, isJsonString, parseJson } from "../json.ts";
import type { JsonValue } from "../json.ts";

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

const asText = (v: JsonValue | undefined): string =>
  isJsonString(v) ? v : isJsonNumber(v) ? String(v) : "";

/**
 * Read + defensively parse `.vgfactory/backlog.json`. Open items first (by
 * priority), done items last — the order the dashboard displays. Returns []
 * when the file is missing, unreadable, or not an array.
 */
export function readBacklog(path: string): BacklogItem[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) return [];

  const items: BacklogItem[] = [];
  for (const [i, raw] of parsed.entries()) {
    const record = asJsonObject(raw);
    if (!record) continue;
    const title = asText(record.title) || asText(record.detail);
    if (!title) continue;
    const priority = asNumber(record.priority) ?? 99;
    items.push({
      id: asText(record.id) || String(i + 1),
      title,
      role: asText(record.role),
      type: asText(record.type),
      priority,
      done: asText(record.status).toLowerCase() === "done",
    });
  }
  items.sort((a, b) => (a.done === b.done ? a.priority - b.priority : a.done ? 1 : -1));
  return items;
}

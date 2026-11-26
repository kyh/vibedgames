import { z } from "zod";

/** A parsed JSON document — what `JSON.parse` can actually produce. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Named so the OpenAPI document shows `JsonValue` rather than a generated id. */
export const jsonValueSchema = z.json().meta({ id: "JsonValue" });

/** Parses JSON text into a checked `JsonValue`; throws on text that is not JSON. */
export const parseJson = (text: string) => {
  const value: JsonValue = jsonValueSchema.parse(JSON.parse(text));

  return value;
};

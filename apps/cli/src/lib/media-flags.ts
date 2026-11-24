import { z } from "zod";

import { parseRunInput, readExplicitLocalFile } from "./media-args.js";
import type { LocalFile } from "./media-args.js";
import { isJsonNumber, isJsonString } from "./types.js";
import type { JsonObject, JsonValue } from "./types.js";

type Schema = z.core.$ZodType;

type Fields = Readonly<Record<string, Schema>>;

type Kind = "array" | "boolean" | "number" | "record" | "string";

const RESERVED = new Set(["options", "wait_seconds"]);

const unwrap: (schema: Schema) => Schema = (schema) =>
  schema instanceof z.ZodOptional || schema instanceof z.ZodDefault
    ? unwrap(schema.def.innerType)
    : schema;

const kindOf: (schema: Schema) => Kind = (schema) => {
  const inner = unwrap(schema);

  if (inner instanceof z.ZodArray) {
    return "array";
  }

  if (inner instanceof z.ZodBoolean) {
    return "boolean";
  }

  if (inner instanceof z.ZodNumber) {
    return "number";
  }

  if (inner instanceof z.ZodRecord) {
    return "record";
  }

  return "string";
};

const elementOf = (schema: Schema) => {
  const inner = unwrap(schema);

  return inner instanceof z.ZodArray ? kindOf(inner.element) : "string";
};

const describe = (schema: Schema) =>
  z.globalRegistry.get(schema)?.description ??
  z.globalRegistry.get(unwrap(schema))?.description ??
  "";

const isLocalFileField = (key: string) => key.endsWith("_url") || key.endsWith("_urls");

/** citty args for an asset procedure's typed fields, one `--<field>` each. */
export const mediaFlagArgs = (fields: Fields) =>
  Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => !RESERVED.has(key))
      .map(([key, schema]) => {
        const kind = kindOf(schema);
        const local = isLocalFileField(key) ? " A local path is uploaded first." : "";
        const many = kind === "array" ? " Repeat or comma-separate." : "";

        return [
          key,
          {
            description: `${describe(schema)}.${many}${local}`.replaceAll("..", "."),
            type: kind === "boolean" ? ("boolean" as const) : ("string" as const),
          },
        ];
      }),
  );

const coerce = (kind: Kind, value: JsonValue) => {
  if (kind === "number") {
    return isJsonString(value) ? Number(value) : value;
  }

  if (kind === "string") {
    return isJsonNumber(value) || value === true || value === false ? String(value) : value;
  }

  return value;
};

const listOf = (value: JsonValue) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (isJsonString(value)) {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  return [value];
};

/**
 * Read an asset procedure's input from argv: its typed `--<field>` flags,
 * coerced to each field's type, plus `--options '<json>'` for any other
 * model input. A local path in a `*_url`/`*_urls` field goes through
 * `upload` first, so a reference image can be passed as a file.
 */
export const readMediaInput = async (
  fields: Fields,
  argv: string[],
  upload: (file: LocalFile) => Promise<string>,
) => {
  const raw = parseRunInput(argv);
  const input: JsonObject = {};

  const resolve = async (key: string, value: JsonValue) => {
    if (!isJsonString(value) || !isLocalFileField(key)) {
      return value;
    }

    const file = readExplicitLocalFile(value);

    return file ? await upload(file) : value;
  };

  for (const [key, schema] of Object.entries(fields)) {
    const value = raw[key];

    if (value === undefined || key === "wait_seconds") {
      continue;
    }

    const kind = kindOf(schema);

    if (kind === "array") {
      const element = elementOf(schema);
      const items: JsonValue[] = [];

      for (const item of listOf(value)) {
        items.push(coerce(element, await resolve(key, item)));
      }

      input[key] = items;
    } else {
      input[key] = coerce(kind, await resolve(key, value));
    }
  }

  return input;
};

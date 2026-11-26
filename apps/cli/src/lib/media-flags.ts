import { runInOrder } from "@repo/contract/run-in-order";
import { z } from "zod";

import { parseRunInput, readExplicitLocalFile } from "./media-args.js";
import type { LocalFile } from "./media-args.js";
import { isJsonNumber, isJsonObject, isJsonString } from "./types.js";
import type { JsonObject, JsonValue } from "./types.js";

type Schema = z.core.$ZodType;

type Fields = Readonly<Record<string, Schema>>;

type Kind = "array" | "boolean" | "number" | "record" | "string";

const RESERVED = new Set(["options", "wait_seconds"]);

const REMOTE = /^(?:https?:|data:)/iu;

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
  upload: (file: LocalFile) => Promise<string> | string,
) => {
  const raw = parseRunInput(argv);
  const input: JsonObject = {};

  const resolve = async (key: string, value: JsonValue) => {
    if (!isJsonString(value) || !isLocalFileField(key)) {
      return value;
    }

    if (REMOTE.test(value)) {
      return value;
    }

    const file = readExplicitLocalFile(value);

    if (!file) {
      throw new Error(`--${key}: no file at ${value}, and it is not an http(s) or data: URL.`);
    }

    return await upload(file);
  };

  await runInOrder(Object.entries(fields), async ([key, schema]) => {
    const kind = kindOf(schema);
    const value = kind === "boolean" && raw[`no-${key}`] === true ? false : raw[key];

    if (value === undefined || key === "wait_seconds") {
      return;
    }

    if (kind === "array") {
      const element = elementOf(schema);

      input[key] = await runInOrder(listOf(value), async (item) =>
        coerce(element, await resolve(key, item)),
      );
    } else if (kind === "record" && isLocalFileField(key) && isJsonObject(value)) {
      const entries = await runInOrder(
        Object.entries(value),
        async ([name, item]) => [name, await resolve(key, item)] as const,
      );

      input[key] = Object.fromEntries(entries);
    } else {
      input[key] = coerce(kind, await resolve(key, value));
    }
  });

  return input;
};

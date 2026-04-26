import { z } from "zod";

/**
 * Converts a string to a URL-friendly slug
 * Removes special characters, converts to lowercase, and replaces spaces with hyphens
 * @param str - The input string to convert to a slug
 * @returns string - A URL-friendly slug
 */
export const slugify = (str: string) => {
  str = str.replace(/^\s+|\s+$/g, ""); // Trim leading/trailing whitespace
  str = str.toLowerCase(); // Convert to lowercase

  // Remove invalid characters, replace spaces and multiple hyphens with a single hyphen
  str = str
    .replace(/[^a-z0-9 -]/g, "") // Remove invalid chars
    .replace(/\s+/g, "-") // Replace spaces with a single hyphen
    .replace(/-+/g, "-"); // Collapse multiple hyphens

  return str;
};

/**
 * 8-char alphanumeric code formatted as `XXXX-XXXX`. Avoids `0/O/1/I` to
 * keep the code unambiguous when read aloud or copied by hand. Used by both
 * the CLI device-code auth flow and the invite-code system.
 */
export const generateShortCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (const b of bytes) {
    code += chars[b % chars.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};

export type Primitive = string | number | boolean | null;

export type JsonType = Primitive | { [key: PropertyKey]: JsonType } | JsonType[];

/**
 * Zod schema for parsing JSON strings
 *
 * Example usage:
 *
 * ```ts
 * const authMetadataSchema = zJsonString.pipe(z.object({
 *   personal: z.boolean(),
 * }));
 * ```
 *
 * ```ts
 * const authMetadata = authMetadataSchema.parse('{"personal": true}');
 * console.log(authMetadata); // { personal: true }
 * ```
 */
export const zJsonString = z.string().transform((str, ctx): JsonType => {
  try {
    return JSON.parse(str) as JsonType;
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid JSON" });
    return z.NEVER;
  }
});

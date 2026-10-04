import { INVITE_CODE_LENGTH } from "@repo/contract/auth/auth-schema";

/**
 * Converts a string to a URL-friendly slug
 * Removes special characters, converts to lowercase, and replaces spaces with hyphens
 * @param str - The input string to convert to a slug
 * @returns string - A URL-friendly slug
 */
export const slugify = (str: string) =>
  str
    .replaceAll(/^\s+|\s+$/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9 -]/gu, "")
    .replaceAll(/\s+/gu, "-")
    .replaceAll(/-+/gu, "-");

// Avoids `0/O/1/I` to keep codes unambiguous when read aloud or copied by hand.
const UNAMBIGUOUS_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Alphanumeric code from an unambiguous alphabet (no `0/O/1/I`) so it stays
 * readable when copied by hand or read aloud. Shared by both the CLI
 * device-code auth flow and the invite-code system.
 */
export const generateShortCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH));
  let code = "";
  for (const b of bytes) {
    code += UNAMBIGUOUS_ALPHABET[b % UNAMBIGUOUS_ALPHABET.length];
  }
  return code;
};

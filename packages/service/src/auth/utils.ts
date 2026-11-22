import { INVITE_CODE_LENGTH } from "@repo/contract/auth/auth-limits";

const UNAMBIGUOUS_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Alphanumeric code from an unambiguous alphabet (no `0/O/1/I`) so it stays
 * readable when copied by hand or read aloud. Mints credit codes.
 */
export const generateShortCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH));
  let code = "";

  for (const b of bytes) {
    code += UNAMBIGUOUS_ALPHABET[b % UNAMBIGUOUS_ALPHABET.length];
  }

  return code;
};

/**
 * Base64 codec helpers shared by the image router and providers.
 *
 * Encoding uses chunked `String.fromCharCode.apply` so we don't pay
 * quadratic memory cost building the binary string for multi-MB inputs.
 */

const ENCODE_CHUNK = 0x8000;

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    const chunk = bytes.subarray(i, i + ENCODE_CHUNK);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

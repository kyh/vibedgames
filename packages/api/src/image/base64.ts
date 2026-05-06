/// <reference lib="esnext.typedarrays" />
/**
 * Base64 codec helpers shared by the image router and providers.
 *
 * Uses native `Uint8Array.fromBase64` / `Uint8Array.prototype.toBase64`
 * (TC39 typed-array base64 proposal, shipped in V8 / Cloudflare Workers).
 */

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.fromBase64(b64);
}

export function bytesToBase64(bytes: Uint8Array): string {
  return bytes.toBase64();
}

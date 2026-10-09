/**
 * The header every `vg` request carries, holding the CLI's version. Builds
 * before it sent none, and they predate oRPC 2.0.0-beta.34, which dropped
 * `inferable` from the error body: apps/web's RPC handler restores the field
 * for them, since their client reads an error without it as malformed.
 */
export const CLI_VERSION_HEADER = "x-vg-cli";

import { TRPCError } from "@trpc/server";

import { bytesToBase64 } from "./base64";
import type { ImageInputFile, ImageInputRole } from "./types";

export function inputsForRole(inputs: ImageInputFile[], role: ImageInputRole): ImageInputFile[] {
  return inputs.filter((input) => input.role === role);
}

export function inputsForRoles(
  inputs: ImageInputFile[],
  roles: ImageInputRole[],
): ImageInputFile[] {
  return inputs.filter((input) => roles.includes(input.role));
}

export function singleInputForRole(
  inputs: ImageInputFile[],
  role: ImageInputRole,
  label: string,
): ImageInputFile | null {
  const matches = inputsForRole(inputs, role);
  if (matches.length > 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} accepts one ${role} image.`,
    });
  }
  return matches[0] ?? null;
}

export function rejectInputRoles(
  inputs: ImageInputFile[],
  roles: ImageInputRole[],
  label: string,
): void {
  const found = inputs.filter((input) => roles.includes(input.role));
  if (found.length === 0) return;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `${label} does not accept ${found.map((input) => input.role).join(", ")} image roles.`,
  });
}

export function rejectImageParams(
  params: Record<string, unknown>,
  fields: string[],
  label: string,
): void {
  const found = fields.filter((field) => params[field] !== undefined);
  if (found.length === 0) return;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `${label} image fields must use uploaded image roles, not params: ${found.join(", ")}.`,
  });
}

export function copyParams(
  params: Record<string, unknown>,
  reserved: string[],
): Record<string, unknown> {
  const copied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (reserved.includes(key)) continue;
    copied[key] = value;
  }
  return copied;
}

export function base64For(image: ImageInputFile): string {
  return bytesToBase64(image.bytes);
}

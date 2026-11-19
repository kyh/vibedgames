import type { JsonValue } from "@repo/contract/json";
import { decideInput } from "@repo/contract/playtest/playtest-schema";
import { COMMON_ERROR_STATUS_MAP, ORPCError } from "@orpc/server";

import type { DecisionProviderConfig } from "../orpc";
import { forwardDecision } from "./playtest-router";
import { verifyPlaytestToken } from "./session-token";

const MAX_BODY_BYTES = 256 * 1024;

const CORS_HEADERS = {
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-max-age": "600",
};

const ERROR_STATUS = new Map<string, number>(Object.entries(COMMON_ERROR_STATUS_MAP));

const respond = (status: number, body: JsonValue) =>
  Response.json(body, { headers: CORS_HEADERS, status });

const fail = (status: number, code: string, message: string) =>
  respond(status, { error: { code, message } });

const bearer = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(?<token>\S+)$/iu.exec(header);

  return match?.groups?.token ?? null;
};

export const handlePlaytestDecide = async (
  request: Request,
  decision: DecisionProviderConfig | undefined,
) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS, status: 204 });
  }

  if (request.method !== "POST") {
    return fail(405, "METHOD_NOT_ALLOWED", "POST only.");
  }

  const secret = decision?.tokenSecret;

  if (!secret) {
    return fail(412, "PRECONDITION_FAILED", "Playtest tokens are not configured on the server.");
  }

  const token = bearer(request);
  const claims = token === null ? null : await verifyPlaytestToken(secret, token);

  if (!claims) {
    return fail(
      401,
      "UNAUTHORIZED",
      "A valid playtest token is required (it expires; start a new run).",
    );
  }

  const declared = Number(request.headers.get("content-length") ?? "");

  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE", `body exceeds ${MAX_BODY_BYTES} bytes.`);
  }

  let text: string;

  try {
    text = await request.text();
  } catch {
    return fail(400, "BAD_REQUEST", "unreadable body.");
  }

  if (text.length > MAX_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE", `body exceeds ${MAX_BODY_BYTES} bytes.`);
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return fail(400, "BAD_REQUEST", "body is not JSON.");
  }

  const parsed = decideInput.safeParse(raw);

  if (!parsed.success) {
    return fail(
      400,
      "BAD_REQUEST",
      `invalid decision request: ${parsed.error.issues[0]?.message ?? "schema"}`,
    );
  }

  try {
    return respond(200, await forwardDecision(decision, parsed.data));
  } catch (error) {
    if (error instanceof ORPCError) {
      return fail(ERROR_STATUS.get(error.code) ?? 500, error.code, error.message);
    }

    return fail(500, "INTERNAL_SERVER_ERROR", "decision failed.");
  }
};

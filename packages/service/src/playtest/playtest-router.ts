import type { JsonValue } from "@repo/contract/json";
import type { DecideInput } from "@repo/contract/playtest/playtest-schema";
import { MAX_STATE_BYTES } from "@repo/contract/playtest/playtest-schema";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { DecisionProviderConfig } from "../orpc";
import {
  fetchProviderResponse,
  readJsonBounded,
  throwProviderError,
} from "../generate/provider-io";
import { os, requireSession } from "../orpc";
import { mintPlaytestToken } from "./session-token";

// ---- The decision-model proxy -----------------------------------------------
//
// `playtest.decide` is the one hop the CLI's `vg playtest run` makes per tick: game state
// plus typed questions in, calibrated answers out. The server holds the
// TypeSafe key; the CLI never sees it. Unlike `generate.forward` this is not
// a generic passthrough — the request shape is TypeSafe's System One request
// and nothing else, so a caller cannot use the key against any other path.
//
// Not metered. A whole run costs a fraction of a cent at the provider's
// published pricing, so the credit ledger would record noise; the size caps
// (the request's in @repo/contract's playtest schema, the reply's below) bound
// what one call can spend.

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";

const MAX_RESPONSE_BYTES = 256 * 1024;

/** Just enough of the provider's reply to know the answers are there. */
const decideResponse = z.looseObject({
  answers: z.record(z.string(), z.unknown()),
});

const pickKey = (decision: DecisionProviderConfig | undefined) => {
  if (!decision?.typesafe) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "The decision model is not configured on the server (TYPESAFE_API_KEY missing).",
    });
  }
  const base = decision.typesafeBaseUrl?.trim() || DEFAULT_BASE_URL;
  return { apiKey: decision.typesafe, base: base.endsWith("/") ? base.slice(0, -1) : base };
};

const serializeState = (state: DecideInput["state"]): string => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(state);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    throw new ORPCError("BAD_REQUEST", { message: "state must be JSON-serializable." });
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) {
    throw new ORPCError("PAYLOAD_TOO_LARGE", {
      message: `state exceeds ${MAX_STATE_BYTES} bytes — send less of the game's diagnostics per tick.`,
    });
  }
  return serialized;
};

const readErrorText = async (res: Response): Promise<string> => {
  try {
    const text = await res.text();
    return text.slice(0, 800);
  } catch {
    return "";
  }
};

/**
 * One decision: forward `{ model, questions, state }` to the provider with
 * the server's key and return its answers verbatim. Typed per question on the
 * client (`vg playtest run` narrows what it asked for); this layer only guarantees
 * the request is a System One request and the reply has answers.
 */
export const forwardDecision = async (
  decision: DecisionProviderConfig | undefined,
  input: DecideInput,
): Promise<JsonValue> => {
  const { apiKey, base } = pickKey(decision);
  const state = serializeState(input.state);
  // Assembled around the already-serialized state rather than stringifying
  // the input twice: the byte check above is on exactly what goes out.
  const body = `{"model":${JSON.stringify(input.model ?? DEFAULT_MODEL)},"questions":${JSON.stringify(input.questions)},"state":${state}}`;

  const provider = "decision model";
  const res = await fetchProviderResponse({
    credentialed: true,
    init: {
      body,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    label: provider,
    tolerateHttpError: true,
    url: `${base}/v1/systemone`,
  });

  if (!res.ok) {
    // A schema rejection is the caller's to fix, so it must not be dressed up
    // as a gateway fault; a rate limit is worth a client backoff; a rejected
    // key is the deploy's problem and says so.
    if (res.status === 422 || res.status === 400) {
      const detail = await readErrorText(res);
      throw new ORPCError("BAD_REQUEST", {
        message: `${provider} rejected the request: ${detail}`,
      });
    }
    if (res.status === 429 || res.status === 529) {
      throw new ORPCError("TOO_MANY_REQUESTS", {
        message: `${provider} is rate-limited or overloaded; retry with backoff.`,
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ORPCError("BAD_GATEWAY", {
        message: `${provider} rejected the server's key (${res.status}); TYPESAFE_API_KEY needs attention.`,
      });
    }
    await throwProviderError(res, provider);
  }

  const parsed: JsonValue = await readJsonBounded(res, `${provider} response`, MAX_RESPONSE_BYTES);
  if (!decideResponse.safeParse(parsed).success) {
    throw new ORPCError("BAD_GATEWAY", { message: `${provider} response had no answers.` });
  }
  return parsed;
};

const authed = os.playtest.use(requireSession);

export const playtestRouter = {
  decide: authed.decide.handler(
    async ({ context, input }) => await forwardDecision(context.decision, input),
  ),

  /**
   * A token for one in-page playtest run: minutes-long, bound to this user,
   * honoured only by `/api/playtest/decide`. The CLI hands it to the game
   * page it is driving, which is untrusted code — so this is all it gets.
   */
  session: authed.session.handler(async ({ context }) => {
    const secret = context.decision?.tokenSecret;
    if (!secret) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "Playtest tokens are not configured on the server.",
      });
    }
    return await mintPlaytestToken(secret, context.session.user.id);
  }),
};

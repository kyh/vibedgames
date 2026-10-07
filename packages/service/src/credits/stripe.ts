import type { Db } from "@repo/db/drizzle-client";
import { z } from "zod";

import type { BillingConfig } from "../orpc";
import { creditPurchase, MICRO_PER_USD } from "./credit-ledger";

/**
 * Credit purchases through Stripe Checkout, spoken over plain `fetch` — the
 * two calls this needs don't earn the SDK's weight in a Worker.
 *
 * The flow: `credits.checkout` creates a Checkout Session for a whole-dollar
 * amount and hands back its hosted URL; the person pays there; Stripe POSTs
 * `checkout.session.completed` to `/api/stripe/webhook`, which verifies the
 * signature and writes one `purchase` ledger entry keyed by the session id.
 * Nothing on the redirect back is trusted — only the signed webhook credits.
 */

const DEFAULT_STRIPE_API = "https://api.stripe.com";

/** Stripe's own default: a signature older than this is a replay. */
const SIGNATURE_TOLERANCE_S = 300;

const CENTS_PER_USD = 100;

export interface CheckoutInput {
  amountUsd: number;
  userId: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
}

export class StripeError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "StripeError";
    this.status = status;
  }
}

const checkoutResponse = z.object({ url: z.url() });

/** Creates a Checkout Session and returns its hosted payment URL. */
export const createCheckoutSession = async (
  billing: BillingConfig & { stripeSecretKey: string },
  input: CheckoutInput,
): Promise<string> => {
  const creditMicro = input.amountUsd * MICRO_PER_USD;
  const form = new URLSearchParams({
    cancel_url: input.cancelUrl,
    client_reference_id: input.userId,
    customer_email: input.email,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][description]": `$${input.amountUsd} of generation credit`,
    "line_items[0][price_data][product_data][name]": "Vibedgames credits",
    "line_items[0][price_data][unit_amount]": String(input.amountUsd * CENTS_PER_USD),
    "line_items[0][quantity]": "1",
    "metadata[creditMicro]": String(creditMicro),
    "metadata[userId]": input.userId,
    mode: "payment",
    // On the PaymentIntent too, so a refund or dispute in the dashboard
    // names the account it belongs to.
    "payment_intent_data[metadata][userId]": input.userId,
    success_url: input.successUrl,
  });

  const res = await fetch(
    `${billing.stripeApiBaseUrl ?? DEFAULT_STRIPE_API}/v1/checkout/sessions`,
    {
      body: form,
      headers: {
        authorization: `Bearer ${billing.stripeSecretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    },
  );
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = z.object({ error: z.object({ message: z.string() }) }).safeParse(body).data
      ?.error.message;
    throw new StripeError(message ?? `Stripe answered ${res.status}`, res.status);
  }
  const parsed = checkoutResponse.safeParse(body);
  if (!parsed.success) {
    throw new StripeError("Stripe returned a checkout session without a URL", 502);
  }
  return parsed.data.url;
};

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Equal-length strings compared without an early exit. */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    // oxlint-disable-next-line no-bitwise -- constant-time compare folds every byte difference into one value
    diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  }
  return diff === 0;
};

/**
 * Verifies a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=…]`): an
 * HMAC-SHA256 of `${t}.${payload}` under the endpoint's signing secret, within
 * SIGNATURE_TOLERANCE_S of `nowS`. Any matching `v1` passes, as Stripe sends
 * one per active secret while a secret is being rolled.
 */
export const verifyStripeSignature = async (
  secret: string,
  header: string,
  payload: string,
  nowS: number,
): Promise<boolean> => {
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isInteger(timestamp) || signatures.length === 0) {
    return false;
  }
  if (Math.abs(nowS - timestamp) > SIGNATURE_TOLERANCE_S) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const expected = hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)),
  );
  return signatures.some((signature) => timingSafeEqual(signature, expected));
};

const checkoutSession = z.object({
  client_reference_id: z.string().min(1),
  currency: z.literal("usd"),
  id: z.string().min(1),
  metadata: z.object({
    creditMicro: z.coerce.number().int().positive(),
    userId: z.string().min(1),
  }),
  payment_status: z.string(),
});

const stripeEvent = z.object({
  data: z.object({ object: z.unknown() }),
  type: z.string(),
});

/** Events that can mean a checkout's money has arrived. */
const PAID_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

export type CreditPurchase = typeof creditPurchase;

/**
 * `POST /api/stripe/webhook`. Answers 2xx for every verified event, handled or
 * not, so Stripe stops redelivering; 400 for a bad signature; 500 when the
 * ledger write fails, so Stripe retries it. A session still `unpaid` on
 * completion (a delayed method such as a bank debit) is credited by its later
 * `async_payment_succeeded`.
 */
export const handleStripeWebhook = async (
  request: Request,
  opts: { db: Db; billing: BillingConfig | undefined },
  credit: CreditPurchase = creditPurchase,
): Promise<Response> => {
  if (request.method !== "POST") {
    return Response.json({ error: "POST only." }, { status: 405 });
  }
  const secret = opts.billing?.stripeWebhookSecret;
  if (!secret) {
    return Response.json({ error: "Stripe webhooks are not configured." }, { status: 412 });
  }
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  if (!(await verifyStripeSignature(secret, signature, payload, Math.floor(Date.now() / 1000)))) {
    return Response.json({ error: "Invalid signature." }, { status: 400 });
  }

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return Response.json({ error: "Unreadable event." }, { status: 400 });
  }
  const event = stripeEvent.safeParse(json);
  if (!event.success || !PAID_EVENTS.has(event.data.type)) {
    return Response.json({ received: true });
  }
  const session = checkoutSession.safeParse(event.data.data.object);
  // A session this server didn't create (no metadata), or one whose two
  // user ids disagree, is not ours to credit.
  if (
    !session.success ||
    session.data.payment_status !== "paid" ||
    session.data.metadata.userId !== session.data.client_reference_id
  ) {
    return Response.json({ received: true });
  }

  await credit(opts.db, {
    checkoutSessionId: session.data.id,
    creditMicro: session.data.metadata.creditMicro,
    userId: session.data.metadata.userId,
  });
  return Response.json({ received: true });
};

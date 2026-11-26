import type { Db } from "@repo/db/drizzle-client";
import { z } from "zod";

import type { BillingConfig } from "../orpc";

import { creditPurchase, MICRO_PER_USD } from "./credit-ledger";

const DEFAULT_STRIPE_API = "https://api.stripe.com";

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

/**
 * Whether card purchases are open. Checkout needs the secret key, and only the
 * webhook (signed with its own secret) credits a payment, so either key alone
 * would take money it can't credit.
 */
export const purchasesEnabled = (
  billing: BillingConfig | undefined,
): billing is BillingConfig & { stripeSecretKey: string; stripeWebhookSecret: string } =>
  Boolean(billing?.stripeSecretKey) && Boolean(billing?.stripeWebhookSecret);

/** Creates a Checkout Session and returns its hosted payment URL. */
export const createCheckoutSession = async (
  billing: BillingConfig & { stripeSecretKey: string },
  input: CheckoutInput,
) => {
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

const SHA256_HEX = /^[0-9a-f]{64}$/u;

const hexBytes = (text: string) =>
  Uint8Array.from(text.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));

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
) => {
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
    ["verify"],
  );

  const signed = new TextEncoder().encode(`${timestamp}.${payload}`);

  const verdicts = await Promise.all(
    signatures
      .filter((signature) => SHA256_HEX.test(signature))
      .map(
        async (signature) => await crypto.subtle.verify("HMAC", key, hexBytes(signature), signed),
      ),
  );

  return verdicts.includes(true);
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
) => {
  if (request.method !== "POST") {
    return Response.json({ error: "POST only." }, { status: 405 });
  }

  const secret = opts.billing?.stripeWebhookSecret;

  if (secret === undefined || secret === "") {
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
